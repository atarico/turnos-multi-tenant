-- ============================================================
-- La prueba vencida deja de tomar turnos nuevos.
--
-- El agujero que cierra: `create_business` abre la suscripción en `trialing`
-- con `trial_ends_at = now() + 14 días`, y NADA la mueve de ahí. No hay
-- pg_cron, no hay trigger, y el webhook de Mercado Pago sólo se despierta si
-- alguien paga — o sea, justamente lo que no pasó. Sumado a que `trialing`
-- está adentro de los estados vivos, un negocio se registraba y usaba el
-- producto gratis para siempre. El checkout funcionaba; nada empujaba a nadie
-- a usarlo.
--
-- El freno va ACÁ y no en el server action, y la razón es un grant: la
-- migración `20260808120001` revocó `create_booking()` de `public` y de
-- `anon`, pero NO de `authenticated` (ver `20260605120004:141`). Un dueño
-- logueado tiene la anon key en su browser y su propio JWT, así que le puede
-- pegar a PostgREST directo y crear turnos salteándose todo el código de
-- Node. Un guard en TypeScript lo esquiva exactamente la persona que este
-- cambio quiere frenar. Del lado de la base no hay vuelta.
--
-- Y va en `create_booking()` sola, no en las dos RPC:
-- `create_public_booking()` delega en ella, así que el panel y la página
-- pública quedan cubiertos por el mismo `if`. Dos copias divergen apenas
-- alguien toque una.
--
-- Lo que NO se toca, y es deliberado: la agenda que el negocio ya tiene se
-- sigue viendo, cerrando, cancelando y reprogramando. `reschedule_booking()`
-- queda intacta. Un turno ya tomado es un compromiso con el CLIENTE del
-- negocio, y romperlo por una deuda del negocio castiga a quien no debe nada
-- — encima dejándolo plantado en la puerta. Lo que se corta es que entre
-- trabajo NUEVO. Esa es toda la presión que hace falta.
-- ============================================================

-- ------------------------------------------------------------
-- ¿Este negocio puede recibir turnos nuevos?
--
-- Una sola pregunta, un solo lugar. La responde por la SUSCRIPCIÓN y no por
-- `tenants.plan`: `plan` dice qué tamaño tiene contratado, nunca dice si lo
-- está pagando. Durante la prueba `tenants.plan` ya dice 'basico', así que
-- mirarlo habría dado "sí" para siempre.
--
-- `trialing` exige que la FECHA no haya pasado. El estado lo mueve el cobro y
-- la fecha la mueve el reloj: entre el vencimiento y un webhook que puede no
-- llegar nunca hay una ventana —potencialmente infinita— donde la etiqueta
-- miente. Mandan los hechos.
--
-- `trial_ends_at` nulo en un `trialing` NO habilita: `null > now()` es null,
-- que no es true, y el `exists` no lo cuenta. Es el mismo criterio que
-- `isInTrial` en TypeScript — sin fecha no hay prueba que defender.
--
-- `past_due` SÍ habilita. El cobro falló pero Mercado Pago lo sigue
-- reintentando, y cortarle la agenda a un negocio que está atendiendo gente
-- por una tarjeta vencida es exactamente lo que no queremos. Espeja
-- `LIVE_STATUSES` en `billing/application/queries.ts`.
-- ------------------------------------------------------------
create or replace function public.tenant_takes_bookings(p_tenant_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.tenant_id = p_tenant_id
      and (
        s.status in ('active', 'past_due')
        or (s.status = 'trialing' and s.trial_ends_at > now())
      )
  );
$$;

-- Sus dos llamadores NO son equivalentes, y confundirlos rompe la página
-- pública entera.
--
-- `create_booking()` es SECURITY DEFINER: corre como el dueño y no necesita
-- grant. La vista `public_tenants` NO. `security_invoker = false` sustituye al
-- dueño SÓLO en el chequeo sobre las RELACIONES que la vista lee; el EXECUTE
-- de una función de su lista de selección lo sigue chequeando el ejecutor
-- contra el rol que consulta, y siendo SECURITY DEFINER el planner no la
-- inlinea, así que ese chequeo se alcanza siempre.
--
-- Verificado contra un Postgres 16 real: revocada de `anon`, leer la vista
-- como `anon` da `permission denied for function tenant_takes_bookings` →
-- `getTenantBySlug` sin fila → `notFound()` → 404 en TODA página pública.
-- El caso 13 del test lo fija.
--
-- Granteárselo a los dos roles de PostgREST no agrega superficie: contesta el
-- mismo booleano que la vista ya publica, sobre un id que ella misma expone.
-- El revoke previo queda igual —patrón del repo— para que el permiso sea
-- EXPLÍCITO y no heredado del `ALTER DEFAULT PRIVILEGES` de Supabase; es la
-- trampa documentada en `20260808120001`.
revoke execute on function public.tenant_takes_bookings(uuid)
  from public, anon, authenticated;

grant execute on function public.tenant_takes_bookings(uuid)
  to anon, authenticated;

-- ------------------------------------------------------------
-- El freno, adentro de la RPC.
--
-- Se recrea la función entera porque `create or replace` la reemplaza toda;
-- el cuerpo es idéntico al de `20260605120003` salvo el bloque nuevo.
--
-- El chequeo va JUSTO DESPUÉS de resolver el negocio y ANTES de validar
-- servicio, profesional y franja. No es cosmético: la respuesta no depende de
-- nada de lo que venga abajo, y ponerlo después haría que a un negocio
-- vencido se le conteste "ese horario no está disponible" —mandándolo a
-- probar otro horario para siempre— en vez de decirle lo que realmente pasa.
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
-- El mismo dato, para la página pública.
--
-- Sin esto un visitante anónimo llenaría el formulario entero —servicio,
-- profesional, día, horario, sus datos— para que recién el submit le conteste
-- que el negocio no está tomando reservas. El freno de arriba es correcto y
-- sería igual de correcto; simplemente llega tarde para el que lo lee.
--
-- Se agrega a la vista y no se consulta `subscriptions` desde la app porque
-- la RLS de esa tabla sólo deja ver la suscripción a los MIEMBROS del negocio
-- (`subscriptions_select_members`), y quien mira una página pública no es
-- miembro de nada. La vista corre con `security_invoker = false`, o sea con
-- los privilegios de su dueño, que es exactamente el mecanismo que ya usa
-- para las otras seis lecturas anónimas.
--
-- Expone UN BOOLEANO y no el estado ni el plan, y esa restricción es la
-- misma que el encabezado de `20260605120004` declara para esta vista: quien
-- entra a reservar necesita saber si puede reservar. Que el negocio esté en
-- prueba, atrasado o cancelado no es asunto suyo.
--
-- `create or replace view` acepta AGREGAR columnas al final; renombrar o
-- reordenar las que ya están habría fallado. Los grants a `anon` y
-- `authenticated` sobreviven al replace, por eso no se re-emiten.
-- ------------------------------------------------------------
create or replace view public.public_tenants
with (security_invoker = false) as
  select
    id,
    slug,
    name,
    timezone,
    brand_color,
    logo_url,
    public.tenant_takes_bookings(id) as takes_bookings
  from public.tenants;
