-- ============================================================
-- Cobro al cliente: la base.
--
-- Un negocio Pro o Premium conecta SU cuenta de Mercado Pago y, si lo
-- prende, el cliente paga el turno completo al reservar online. La plata va
-- del cliente a la cuenta del negocio: la plataforma no intermedia ni cobra
-- comisión. Esta migración sólo pone el suelo; aplicar un pago (T5) y las
-- devoluciones (T7) vienen después.
--
-- ## Una sola regla, un solo lugar
--
-- `tenant_requires_payment()` contesta "¿este negocio exige pago hoy?" y es la
-- ÚNICA que lo decide: flag prendido Y plan efectivo >= pro Y cuenta
-- conectada. Que sea una función y no un flag guardado es el punto: un negocio
-- que baja a Basic, o cuya conexión se rompe, deja de exigir pago sin que
-- nadie tenga que apagar nada — y nunca queda un cliente frente a un cobro
-- que el negocio ya no puede recibir.
--
-- ## Los tokens
--
-- `tenant_mp_accounts` guarda los tokens OAuth del negocio YA CIFRADOS por la
-- app (AES-256-GCM, clave en el entorno). La base nunca ve un token en claro,
-- y ninguna sesión llega a la tabla: RLS prendida sin policies y todos los
-- privilegios revocados. Sólo `service_role` la toca.
-- ============================================================

-- ------------------------------------------------------------
-- La cuenta de Mercado Pago del negocio
--
-- `status`: 'connected' o 'broken' (token revocado o refresh fallido). Una
-- cuenta rota deja de exigir pago —ver `tenant_requires_payment`— y el panel
-- le avisa al dueño hasta que reconecte.
-- ------------------------------------------------------------
create table public.tenant_mp_accounts (
  tenant_id                uuid primary key references public.tenants(id) on delete cascade,
  mp_user_id               text        not null,
  public_key               text,
  access_token_ciphertext  text        not null,
  refresh_token_ciphertext text        not null,
  access_token_expires_at  timestamptz not null,
  status                   text        not null default 'connected'
                             check (status in ('connected', 'broken')),
  connected_at             timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger tenant_mp_accounts_set_updated_at
  before update on public.tenant_mp_accounts
  for each row execute function public.set_updated_at();

-- Puerta tapiada, no puerta abierta: RLS sin una sola policy. El revoke es la
-- segunda reja: los default privileges de Supabase le dan ALL a anon y
-- authenticated en toda tabla nueva, y apoyar un secreto en que la RLS de al
-- lado aguante es la forma exacta del agujero de `20260830120001`.
alter table public.tenant_mp_accounts enable row level security;
revoke all on public.tenant_mp_accounts from anon, authenticated, public;

comment on table public.tenant_mp_accounts is
  'Tokens OAuth de Mercado Pago de cada negocio, cifrados por la app. Sin '
  'policies y sin privilegios para sesiones: sólo service_role.';

-- ------------------------------------------------------------
-- El flag del módulo
--
-- NO se agrega a la lista blanca de `20260830120001`: la columna nace cerrada
-- para toda sesión, y la única puerta de escritura es `set_online_payments()`.
-- ------------------------------------------------------------
alter table public.tenants
  add column online_payments_enabled boolean not null default false;

-- ------------------------------------------------------------
-- Plan efectivo, en SQL
--
-- Hasta hoy el plan efectivo sólo se calculaba en TypeScript
-- (`effectivePlan` en `billing/domain/courtesy.ts`). Acá se espeja EXACTO, y
-- por el mismo motivo: se resuelve al LEER, así que una cortesía vencida caduca
-- sola. Sin cortesía → lo pagado; cortesía vencida (`until <= now()`) → lo
-- pagado; si no, la MEJOR de las dos: un regalo nunca empeora lo comprado. El
-- enum está ordenado basico < pro < premium, por eso `greatest()` alcanza.
--
-- Sólo `service_role`: la llaman funciones definer, y el panel ya lo calcula
-- del lado de Node.
-- ------------------------------------------------------------
create or replace function public.tenant_effective_plan(p_tenant_id uuid)
returns public.plan_tier
language sql
stable
security definer set search_path = public
as $$
  select case
    when t.plan_courtesy is null then t.plan
    when t.plan_courtesy_until is not null
         and t.plan_courtesy_until <= now() then t.plan
    else greatest(t.plan, t.plan_courtesy)
  end
  from public.tenants t
  where t.id = p_tenant_id;
$$;

revoke execute on function public.tenant_effective_plan(uuid)
  from public, anon, authenticated;
grant execute on function public.tenant_effective_plan(uuid) to service_role;

-- ------------------------------------------------------------
-- ¿Este negocio exige pago hoy?
--
-- Un negocio inexistente no exige nada (el `exists` da false). Es SECURITY
-- DEFINER porque lee `tenant_mp_accounts`, a la que ninguna sesión llega; sólo
-- devuelve un booleano, nunca un token. Sólo `service_role`: con cualquier otro
-- rol, un usuario registrado podría preguntar por el plan y la conexión de
-- Mercado Pago de CUALQUIER negocio con sólo pasarle su uuid. La reserva
-- pública corre con el cliente admin; si el panel necesita la respuesta, T3
-- agrega una función acotada a los miembros del negocio.
-- ------------------------------------------------------------
create or replace function public.tenant_requires_payment(p_tenant_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.tenants t
    join public.tenant_mp_accounts a on a.tenant_id = t.id
    where t.id = p_tenant_id
      and t.online_payments_enabled
      and a.status = 'connected'
      and public.tenant_effective_plan(t.id) >= 'pro'
  );
$$;

revoke execute on function public.tenant_requires_payment(uuid)
  from public, anon, authenticated;
grant execute on function public.tenant_requires_payment(uuid)
  to service_role;

-- ------------------------------------------------------------
-- Prender / apagar el módulo
--
-- Es la única puerta de escritura del flag. SECURITY DEFINER con la
-- autorización ADENTRO (mismo criterio que `grant_plan_courtesy`): un grant a
-- un rol no puede preguntar "¿sos el dueño de ESTE negocio?".
--
-- Sólo el DUEÑO, no un admin: es una decisión sobre dónde cae la plata.
-- Un extraño y un admin reciben el mismo 42501, sin revelar si el negocio
-- existe.
--
-- Prender exige plan efectivo >= pro y cuenta conectada, y cada motivo da un
-- error DISTINTO (ambos P0001) para que la pantalla le diga al dueño qué
-- le falta. Apagar se puede siempre: el negocio que bajó de plan con el flag
-- prendido tiene que poder dejarlo limpio.
-- ------------------------------------------------------------
create or replace function public.set_online_payments(
  p_tenant_id uuid,
  p_enabled   boolean
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id   = auth.uid()
      and m.role      = 'owner'
  ) then
    raise exception 'Solo el dueño del negocio puede cambiar los cobros online'
      using errcode = 'insufficient_privilege';
  end if;

  if p_enabled then
    if public.tenant_effective_plan(p_tenant_id) < 'pro' then
      raise exception 'Los cobros online requieren el plan Pro o superior'
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1 from public.tenant_mp_accounts a
      where a.tenant_id = p_tenant_id and a.status = 'connected'
    ) then
      raise exception 'Mercado Pago no está conectado'
        using errcode = 'P0001';
    end if;
  end if;

  update public.tenants
     set online_payments_enabled = p_enabled
   where id = p_tenant_id;
end;
$$;

revoke execute on function public.set_online_payments(uuid, boolean)
  from public, anon;
grant execute on function public.set_online_payments(uuid, boolean)
  to authenticated;

-- ------------------------------------------------------------
-- El estado de pago del turno
--
-- not_required → el turno no pasa por pago (el caso de siempre).
-- awaiting     → hold: esperando el pago, vence en `payment_expires_at`.
-- paid         → cobrado.
-- refund_due   → hay que devolverle la plata (la devuelve el dueño a mano).
-- refunded     → devuelta.
-- T1 sólo crea 'not_required' y 'awaiting'; el resto lo mueven T5 y T7.
-- ------------------------------------------------------------
create type public.booking_payment_status as enum (
  'not_required', 'awaiting', 'paid', 'refund_due', 'refunded'
);

alter table public.bookings
  add column payment_status     public.booking_payment_status not null default 'not_required',
  add column payment_expires_at timestamptz,
  -- Un hold sin vencimiento nunca se libera: ocuparía la franja para siempre.
  add constraint bookings_awaiting_has_expiry
    check (payment_status <> 'awaiting' or payment_expires_at is not null);

-- Un hold NUNCA está 'confirmed': la confirmación de un turno que espera pago
-- sólo ocurre por el camino del pago (T5), que mueve `payment_status` a 'paid'
-- en el mismo UPDATE. Sin este CHECK, el UPDATE de `status` que el panel SÍ
-- tiene grantado confirmaba a mano un turno que nadie pagó.
alter table public.bookings
  add constraint bookings_awaiting_not_confirmed
    check (not (status = 'confirmed' and payment_status = 'awaiting'));

-- ------------------------------------------------------------
-- Los campos de pago NO los escribe una sesión
--
-- `bookings_update_members` decide qué FILAS toca un miembro, no qué COLUMNAS,
-- y los default privileges le dan UPDATE de tabla entera a `authenticated`.
-- Sin esto, un dueño con su JWT pegándole a PostgREST se marcaba 'paid' o
-- estiraba el vencimiento de su propio hold. Mismo agujero, misma solución
-- que `20260830120001`: se revoca el UPDATE y se devuelve sobre las columnas
-- que YA eran escribibles, todas menos las dos nuevas y `id` (que ninguna
-- sesión tiene motivo para reescribir). Nada de lo que hoy
-- funciona cambia (la app sólo escribe `status`); lo que se agregue de acá en
-- adelante nace cerrado. `payment_status` y `payment_expires_at` los mueven
-- sólo funciones definer y `service_role`, que no pasan por estos grants.
-- ------------------------------------------------------------
revoke update on public.bookings from anon, authenticated, public;

grant update (
  tenant_id, staff_id, service_id,
  customer_name, customer_email, customer_phone,
  starts_at, ends_at, status, notes,
  created_at, updated_at,
  price_cents, currency, service_name, staff_name,
  reminder_sent_at
) on public.bookings to authenticated;

-- ------------------------------------------------------------
-- Un hold vencido no ocupa cupo
--
-- 'pending' + 'awaiting' + `payment_expires_at <= now()` queda FUERA de toda
-- cuenta de carga viva. Se evalúa al LEER, sin cron: la franja se libera sola
-- a los 15 minutos aunque ningún proceso corra (el cron de T6 sólo limpia el
-- estado después). Las tres cuentas repiten el mismo predicado; si cambia,
-- cambia en las tres.
--
-- Las funciones se recrean enteras, tomando como base su ÚLTIMA definición:
-- `create_booking` de `20260903120001` y `reschedule_booking` de
-- `20260803120001`. El único cambio es el predicado de arriba.
-- ------------------------------------------------------------
create or replace function public.create_booking(
  p_tenant_slug    text,
  p_staff_id       uuid,
  p_service_id     uuid,
  p_starts_at      timestamptz,
  p_customer_name  text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_notes          text default null
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant   public.tenants;
  v_service  public.services;
  v_staff    public.staff;
  v_ends_at  timestamptz;
  v_weekday  smallint;
  v_local_s  time;
  v_local_e  time;
  v_taken    int;
  v_others   int;
  v_booking  public.bookings;
begin
  -- ----- Resolver y validar el negocio -----
  select * into v_tenant from public.tenants where slug = p_tenant_slug;
  if not found then
    raise exception 'Negocio inexistente' using errcode = 'P0002';
  end if;

  -- ----- El negocio tiene que estar habilitado a recibir turnos -----
  if not public.tenant_takes_bookings(v_tenant.id) then
    raise exception 'Negocio sin plan activo' using errcode = 'P0001';
  end if;

  -- ----- Validar servicio (del negocio y activo) -----
  select * into v_service
    from public.services
    where id = p_service_id and tenant_id = v_tenant.id and active;
  if not found then
    raise exception 'Servicio no disponible' using errcode = 'P0002';
  end if;

  -- ----- Validar profesional (del negocio y activo) -----
  select * into v_staff
    from public.staff
    where id = p_staff_id and tenant_id = v_tenant.id and active;
  if not found then
    raise exception 'Profesional no disponible' using errcode = 'P0002';
  end if;

  -- ----- El profesional tiene que ofrecer ese servicio -----
  if not exists (
    select 1 from public.staff_services
    where staff_id = p_staff_id and service_id = p_service_id
  ) then
    raise exception 'Ese profesional no ofrece este servicio' using errcode = 'P0001';
  end if;

  -- ----- No se reserva en el pasado -----
  if p_starts_at <= now() then
    raise exception 'Esa franja ya pasó' using errcode = 'P0001';
  end if;

  v_ends_at := p_starts_at + make_interval(mins => v_service.duration_min);

  -- ----- La franja tiene que caer dentro de la disponibilidad -----
  -- Se evalúa en hora LOCAL del negocio (su timezone).
  v_weekday := extract(dow from (p_starts_at at time zone v_tenant.timezone))::smallint;
  v_local_s := (p_starts_at at time zone v_tenant.timezone)::time;
  v_local_e := (v_ends_at  at time zone v_tenant.timezone)::time;

  if not exists (
    select 1 from public.staff_availability a
    where a.staff_id = p_staff_id
      and a.weekday = v_weekday
      and a.start_time <= v_local_s
      and a.end_time   >= v_local_e
  ) then
    raise exception 'El profesional no atiende en ese horario' using errcode = 'P0001';
  end if;

  -- ----- Serializar las reservas de ESTE profesional -----
  -- Lock por (staff). Se libera solo al cerrar la transacción.
  perform pg_advisory_xact_lock(hashtextextended(p_staff_id::text, 0));

  -- Reservas vivas del profesional que se SOLAPAN con la franja pedida.
  -- "Misma sesión" = mismo servicio y mismo inicio (clase grupal compartida).
  select
    count(*) filter (where service_id = p_service_id and starts_at = p_starts_at),
    count(*) filter (where not (service_id = p_service_id and starts_at = p_starts_at))
  into v_taken, v_others
  from public.bookings
  where staff_id = p_staff_id
    and status in ('pending', 'confirmed')
    -- Un hold de pago VENCIDO no ocupa cupo (ver `booking_payment_status`).
    and not (status = 'pending' and payment_status = 'awaiting'
             and payment_expires_at <= now())
    and starts_at < v_ends_at
    and ends_at   > p_starts_at;

  -- Solapa con otra sesión distinta → el profesional está ocupado.
  if v_others > 0 then
    raise exception 'El profesional ya tiene un turno en ese horario' using errcode = 'P0001';
  end if;

  -- Misma sesión grupal pero sin cupo libre.
  if v_taken >= v_service.capacity then
    raise exception 'No quedan lugares en esa franja' using errcode = 'P0001';
  end if;

  -- ----- Insertar -----
  insert into public.bookings (
    tenant_id, staff_id, service_id,
    customer_name, customer_email, customer_phone,
    starts_at, ends_at, notes
  ) values (
    v_tenant.id, p_staff_id, p_service_id,
    p_customer_name, p_customer_email, p_customer_phone,
    p_starts_at, v_ends_at, p_notes
  )
  returning * into v_booking;

  return v_booking;
end;
$$;

-- ------------------------------------------------------------
-- reschedule_booking(): mismo cambio, mismo predicado.
-- ------------------------------------------------------------
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_starts_at  timestamptz,
  p_staff_id   uuid default null
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking  public.bookings;
  v_tenant   public.tenants;
  v_service  public.services;
  v_staff    public.staff;
  v_staff_id uuid;
  v_ends_at  timestamptz;
  v_weekday  smallint;
  v_local_s  time;
  v_local_e  time;
  v_taken    int;
  v_others   int;
begin
  -- ----- Aislamiento: el turno tiene que ser de MI negocio -----
  select * into v_booking
    from public.bookings
    where id = p_booking_id
      and tenant_id in (select public.auth_tenant_ids());
  if not found then
    raise exception 'Turno inexistente' using errcode = 'P0002';
  end if;

  -- ----- Sólo se mueve un turno VIVO -----
  -- Reprogramar uno cancelado o ya cerrado lo resucitaría salteando
  -- el ciclo de vida. Para eso se crea un turno nuevo.
  if v_booking.status not in ('pending', 'confirmed') then
    raise exception 'Ese turno ya está cerrado' using errcode = 'P0001';
  end if;

  -- ----- Un hold de pago no se mueve -----
  -- Vencido o no: mientras espera el pago no es un turno de verdad todavía, y
  -- moverlo lo dejaría pendiente en una franja que el cliente nunca eligió.
  -- Si el hold vence, el cliente reserva de nuevo.
  if v_booking.payment_status = 'awaiting' then
    raise exception 'Ese turno espera un pago: no se puede reprogramar'
      using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_booking.tenant_id;

  -- El servicio NO cambia: cambiarlo cambia duración y precio, o sea
  -- es otro turno. Se lee para recalcular el fin de la franja.
  select * into v_service
    from public.services
    where id = v_booking.service_id;
  if not found then
    raise exception 'Servicio no disponible' using errcode = 'P0002';
  end if;

  -- ----- Profesional destino: el que venga, o el mismo de antes -----
  v_staff_id := coalesce(p_staff_id, v_booking.staff_id);

  select * into v_staff
    from public.staff
    where id = v_staff_id and tenant_id = v_booking.tenant_id and active;
  if not found then
    raise exception 'Profesional no disponible' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.staff_services
    where staff_id = v_staff_id and service_id = v_booking.service_id
  ) then
    raise exception 'Ese profesional no ofrece este servicio' using errcode = 'P0001';
  end if;

  -- ----- No se reprograma hacia el pasado -----
  if p_starts_at <= now() then
    raise exception 'Esa franja ya pasó' using errcode = 'P0001';
  end if;

  v_ends_at := p_starts_at + make_interval(mins => v_service.duration_min);

  -- ----- La franja nueva tiene que caer dentro de la disponibilidad -----
  v_weekday := extract(dow from (p_starts_at at time zone v_tenant.timezone))::smallint;
  v_local_s := (p_starts_at at time zone v_tenant.timezone)::time;
  v_local_e := (v_ends_at  at time zone v_tenant.timezone)::time;

  if not exists (
    select 1 from public.staff_availability a
    where a.staff_id = v_staff_id
      and a.weekday = v_weekday
      and a.start_time <= v_local_s
      and a.end_time   >= v_local_e
  ) then
    raise exception 'El profesional no atiende en ese horario' using errcode = 'P0001';
  end if;

  -- ----- Serializar las reservas del profesional DESTINO -----
  -- Sólo el destino: el profesional de origen queda MÁS libre al irse
  -- este turno, y liberar cupo no puede violar ninguna restricción.
  perform pg_advisory_xact_lock(hashtextextended(v_staff_id::text, 0));

  -- Ojo con el `id <> p_booking_id`: sin esa exclusión, el turno choca
  -- CONSIGO MISMO al moverse unos minutos dentro de su propia franja,
  -- y correr un turno de 10:00 a 10:15 sería imposible.
  select
    count(*) filter (where service_id = v_booking.service_id and starts_at = p_starts_at),
    count(*) filter (where not (service_id = v_booking.service_id and starts_at = p_starts_at))
  into v_taken, v_others
  from public.bookings
  where staff_id = v_staff_id
    and id <> p_booking_id
    and status in ('pending', 'confirmed')
    -- Un hold de pago VENCIDO no ocupa cupo (ver `booking_payment_status`).
    and not (status = 'pending' and payment_status = 'awaiting'
             and payment_expires_at <= now())
    and starts_at < v_ends_at
    and ends_at   > p_starts_at;

  if v_others > 0 then
    raise exception 'El profesional ya tiene un turno en ese horario' using errcode = 'P0001';
  end if;

  if v_taken >= v_service.capacity then
    raise exception 'No quedan lugares en esa franja' using errcode = 'P0001';
  end if;

  -- ----- Mover -----
  -- El estado NO se toca: un turno confirmado sigue confirmado después
  -- de moverse. `updated_at` lo pone el trigger bookings_set_updated_at.
  update public.bookings
     set staff_id  = v_staff_id,
         starts_at = p_starts_at,
         ends_at   = v_ends_at
   where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$$;

-- La vista de carga pública: mismas columnas, mismo orden (por eso alcanza un
-- `create or replace`), y los grants a anon/authenticated sobreviven.
create or replace view public.public_booking_load
with (security_invoker = false) as
  select staff_id, service_id, starts_at, ends_at
  from public.bookings
  where status in ('pending', 'confirmed')
    and not (status = 'pending' and payment_status = 'awaiting'
             and payment_expires_at <= now())
    and starts_at >= now();

-- ------------------------------------------------------------
-- La reserva pública, con hold cuando se exige pago
--
-- Base: `20260808120001`. Los grants (sólo `service_role`) sobreviven al
-- replace. La rama nueva queda DESPUÉS de `create_booking()`: ver el comentario
-- en el cuerpo.
-- ------------------------------------------------------------
create or replace function public.create_public_booking(
  p_tenant_slug    text,
  p_staff_id       uuid,
  p_service_id     uuid,
  p_starts_at      timestamptz,
  p_customer_name  text,
  p_ip_hash        text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_notes          text default null
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  -- Una IP honesta reservando para su familia no llega a 5 turnos en una hora;
  -- un script sí, y en el primer minuto.
  c_max_per_hour constant int := 5;
  v_recent       int;
  v_booking      public.bookings;
begin
  if p_ip_hash is null or length(trim(p_ip_hash)) = 0 then
    raise exception 'Origen no identificado' using errcode = 'P0001';
  end if;

  -- Serializar los intentos de ESTE origen antes de contarlos.
  --
  -- Sin el lock el freno no frena: contar y después insertar son dos pasos, y
  -- entre uno y otro entra cualquiera. Dos requests simultáneas leen las dos
  -- "van 4" y pasan las dos; cien requests en paralelo leen las cien "van 0" y
  -- pasan las cien. O sea que frenaría a una persona y no a un script, que es
  -- exactamente el atacante contra el que existe esto.
  --
  -- Mismo primitivo que usa `create_booking()` para el cupo, un nivel más
  -- arriba. El orden de toma es siempre origen → profesional, nunca al revés,
  -- así que no se puede armar un ciclo entre los dos locks.
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 0));

  select count(*) into v_recent
    from public.booking_attempts
   where ip_hash = p_ip_hash
     and created_at > now() - interval '1 hour';

  if v_recent >= c_max_per_hour then
    raise exception 'Demasiadas reservas seguidas' using errcode = 'P0001';
  end if;

  insert into public.booking_attempts (ip_hash) values (p_ip_hash);

  v_booking := public.create_booking(
    p_tenant_slug,
    p_staff_id,
    p_service_id,
    p_starts_at,
    p_customer_name,
    p_customer_email,
    p_customer_phone,
    p_notes
  );

  -- Si el negocio exige pago, la reserva queda en HOLD: pendiente, esperando
  -- el pago, y vencida a los 15 minutos. Se marca acá y no dentro de
  -- `create_booking()` a propósito: esa función también la usa el panel, y un
  -- turno que el dueño carga a mano nunca espera un pago. El UPDATE corre en la
  -- misma transacción y con el lock del profesional todavía tomado, así que
  -- nadie ve el turno como 'confirmed' ni se cuela en el medio. 'pending' y
  -- 'confirmed' ocupan cupo igual, por lo que la franja no se libera.
  -- Y sólo si hay algo que cobrar: un servicio gratis (`price_cents` en 0 o sin
  -- precio) no tiene pago posible, así que una reserva sin hold evita dejar al
  -- cliente frente a un checkout de $0 que Mercado Pago rechaza.
  if coalesce(v_booking.price_cents, 0) > 0
     and public.tenant_requires_payment(v_booking.tenant_id) then
    update public.bookings
       set status             = 'pending',
           payment_status     = 'awaiting',
           payment_expires_at = now() + interval '15 minutes'
     where id = v_booking.id
    returning * into v_booking;
  end if;

  -- Higiene: las filas viejas ya no deciden nada. Se limpian acá y no con un
  -- cron para no sumar infraestructura por una tabla que se poda sola.
  delete from public.booking_attempts
   where created_at < now() - interval '1 day';

  return v_booking;
end;
$$;

-- ------------------------------------------------------------
-- Recordatorios: un turno que espera pago no recibe ninguno
--
-- Base: `20260909120001`. Los grants (sólo `service_role`) sobreviven al
-- replace. Único cambio: `payment_status <> 'awaiting'`.
-- ------------------------------------------------------------
create or replace function public.bookings_due_for_reminder(
  p_limit int default 500
)
returns table (
  booking_id     uuid,
  tenant_name    text,
  timezone       text,
  service_name   text,
  staff_name     text,
  starts_at      timestamptz,
  customer_name  text,
  customer_email text
)
language sql
stable
security definer set search_path = public
as $$
  select
    b.id,
    t.name,
    t.timezone,
    s.name,
    st.name,
    b.starts_at,
    b.customer_name,
    b.customer_email
  from public.bookings b
  join public.tenants  t  on t.id  = b.tenant_id
  join public.services s  on s.id  = b.service_id
  -- `left join`: el profesional puede no estar asignado, y eso no es motivo
  -- para dejar a alguien sin recordatorio. El mail omite esa línea.
  left join public.staff st on st.id = b.staff_id
  where b.status in ('pending', 'confirmed')
    -- Un turno que espera un pago (vigente o vencido) no es un turno de verdad
    -- todavía: recordarle "mañana te esperamos" a quien no pagó es el mail
    -- equivocado.
    and b.payment_status <> 'awaiting'
    and b.customer_email is not null
    and b.reminder_sent_at is null
    and (b.starts_at at time zone t.timezone)::date
        = ((now() at time zone t.timezone)::date + 1)
  order by b.starts_at
  limit p_limit;
$$;

-- ------------------------------------------------------------
-- Borrar un servicio / profesional: un hold vencido no lo bloquea
--
-- Base: `20260811120001` (`20260813120001` no las redefine). SECURITY INVOKER
-- igual que antes. Único cambio: el bloque que cancela los holds vencidos
-- antes de contar.
-- ------------------------------------------------------------
create or replace function public.delete_service(
  p_tenant_id  uuid,
  p_service_id uuid
)
returns public.delete_outcome
language plpgsql
security invoker set search_path = public
as $$
declare
  v_upcoming int;
  v_history  int;
begin
  perform 1 from public.services
   where id = p_service_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Servicio inexistente' using errcode = 'P0002';
  end if;

  -- Un hold de pago VENCIDO no cuenta como agenda vigente. Pero tampoco puede
  -- quedar 'pending' con el vínculo colgando: el CHECK exige el vínculo vivo
  -- mientras el turno no es terminal, y el borrado chocaría con la FK. Se lo
  -- cancela acá —es lo que el cron de T6 haría igual— y el `update` de más
  -- abajo lo desvincula como a cualquier cancelado.
  update public.bookings
     set status = 'cancelled'
   where service_id = p_service_id
     and status = 'pending'
     and payment_status = 'awaiting'
     and payment_expires_at <= now();

  select
    count(*) filter (where status in ('pending', 'confirmed')),
    count(*) filter (where status = 'completed')
    into v_upcoming, v_history
    from public.bookings
   where service_id = p_service_id;

  if v_upcoming > 0 then
    return 'blocked_upcoming';
  end if;

  if v_history > 0 then
    return 'blocked_history';
  end if;

  update public.bookings
     set service_id = null
   where service_id = p_service_id
     and status in ('cancelled', 'no_show');

  delete from public.services where id = p_service_id;

  return 'deleted';
end;
$$;

create or replace function public.delete_staff(
  p_tenant_id uuid,
  p_staff_id  uuid
)
returns public.delete_outcome
language plpgsql
security invoker set search_path = public
as $$
declare
  v_upcoming int;
  v_history  int;
begin
  perform 1 from public.staff
   where id = p_staff_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Profesional inexistente' using errcode = 'P0002';
  end if;

  -- Un hold de pago VENCIDO no cuenta como agenda vigente. Pero tampoco puede
  -- quedar 'pending' con el vínculo colgando: el CHECK exige el vínculo vivo
  -- mientras el turno no es terminal, y el borrado chocaría con la FK. Se lo
  -- cancela acá —es lo que el cron de T6 haría igual— y el `update` de más
  -- abajo lo desvincula como a cualquier cancelado.
  update public.bookings
     set status = 'cancelled'
   where staff_id = p_staff_id
     and status = 'pending'
     and payment_status = 'awaiting'
     and payment_expires_at <= now();

  select
    count(*) filter (where status in ('pending', 'confirmed')),
    count(*) filter (where status = 'completed')
    into v_upcoming, v_history
    from public.bookings
   where staff_id = p_staff_id;

  if v_upcoming > 0 then
    return 'blocked_upcoming';
  end if;

  if v_history > 0 then
    return 'blocked_history';
  end if;

  update public.bookings
     set staff_id = null
   where staff_id = p_staff_id
     and status in ('cancelled', 'no_show');

  delete from public.staff where id = p_staff_id;

  return 'deleted';
end;
$$;


-- ------------------------------------------------------------
-- Los pagos de cada turno
--
-- Un miembro VE los pagos de su negocio; no escribe ninguno. Escribe sólo el
-- service role (el webhook, T5): RLS sin policies de escritura y los
-- privilegios de escritura revocados, las dos rejas.
--
-- `booking_id` sin `on delete cascade`: borrar un turno que tiene un pago no
-- debe borrar el rastro de la plata. La FK frena el delete (NO ACTION, que se
-- chequea al final de la sentencia, así que un `delete` del negocio que
-- arrastra turnos y pagos juntos sigue andando).
-- ------------------------------------------------------------
create table public.booking_payments (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid        not null references public.bookings(id),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  mp_preference_id text,
  mp_payment_id    text unique,
  status           text,
  amount_cents     integer     not null check (amount_cents >= 0),
  currency         text        not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index booking_payments_booking_idx on public.booking_payments(booking_id);
create index booking_payments_tenant_idx  on public.booking_payments(tenant_id);

create trigger booking_payments_set_updated_at
  before update on public.booking_payments
  for each row execute function public.set_updated_at();

alter table public.booking_payments enable row level security;

create policy "booking_payments_select_members"
  on public.booking_payments for select
  using (tenant_id in (select public.auth_tenant_ids()));

revoke all on public.booking_payments from anon, public;
revoke insert, update, delete, truncate, references, trigger
  on public.booking_payments from authenticated;
-- Patrón del repo: revocar y después conceder EXPLÍCITO lo que se quiere, así
-- el SELECT del miembro no depende de los default privileges de Supabase.
grant select on public.booking_payments to authenticated;

-- ------------------------------------------------------------
-- Dedup de eventos del proveedor
--
-- Mercado Pago reintenta, así que el mismo aviso llega más de una vez. La
-- clave (provider, provider_event_id) hace que el segundo insert falle y el
-- webhook sepa que ya lo aplicó. Deny-all, igual que `tenant_mp_accounts`.
-- ------------------------------------------------------------
create table public.payment_events (
  provider          text        not null,
  provider_event_id text        not null,
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  received_at       timestamptz not null default now(),
  primary key (provider, provider_event_id)
);

create index payment_events_tenant_idx on public.payment_events(tenant_id);

alter table public.payment_events enable row level security;
revoke all on public.payment_events from anon, authenticated, public;
