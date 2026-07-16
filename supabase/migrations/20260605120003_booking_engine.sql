-- ============================================================
-- 0003 — Motor de turnos
-- Profesionales (staff), su disponibilidad semanal, qué servicios
-- ofrece cada uno, y las reservas (bookings) con cupo por franja.
--
-- Decisión de modelo (sesión Fase 2):
--   · Se reserva contra un PROFESIONAL (no contra el negocio).
--   · Una franja admite CUPOS MÚLTIPLES (clases grupales) → la
--     capacidad vive en el servicio y el anti-doble-booking es un
--     CONTEO contra ese cupo, no una simple exclusión de rangos.
-- ============================================================

-- ---------- Tipos ----------
-- Ciclo de vida de una reserva. 'pending'/'confirmed' OCUPAN cupo;
-- 'cancelled'/'no_show' lo liberan; 'completed' es histórico.
create type public.booking_status as enum (
  'pending', 'confirmed', 'cancelled', 'completed', 'no_show'
);

-- ---------- services: cupo por franja ----------
-- 1 = turno 1-a-1 clásico. >1 = clase/sesión grupal (ej. yoga = 10).
alter table public.services
  add column capacity int not null default 1 check (capacity > 0);

-- ---------- staff (profesionales / recursos del negocio) ----------
create table public.staff (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  role       text,                         -- "Peluquera", "Kinesiólogo"... libre
  avatar_url text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_tenant_id_idx on public.staff(tenant_id);

create trigger staff_set_updated_at
  before update on public.staff
  for each row execute function public.set_updated_at();

-- ---------- staff_services (qué ofrece cada profesional, N:N) ----------
-- Un servicio lo pueden dar varios profesionales y un profesional da
-- varios servicios. La reserva sólo es válida si el par existe acá.
create table public.staff_services (
  staff_id   uuid not null references public.staff(id)    on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  primary key (staff_id, service_id)
);

create index staff_services_service_idx on public.staff_services(service_id);

-- ---------- staff_availability (horario semanal recurrente) ----------
-- weekday: 0=domingo … 6=sábado (espeja extract(dow)). Los horarios
-- son hora LOCAL del negocio (se interpretan con tenants.timezone).
create table public.staff_availability (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff(id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time   time not null,
  constraint availability_range check (end_time > start_time)
);

create index staff_availability_staff_idx on public.staff_availability(staff_id);

-- ---------- bookings (reservas) ----------
-- tenant_id va denormalizado a propósito: simplifica la RLS y el conteo
-- de cupo sin tener que joinear staff en cada policy.
create table public.bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id)  on delete cascade,
  staff_id       uuid not null references public.staff(id)    on delete cascade,
  service_id     uuid not null references public.services(id) on delete restrict,
  customer_name  text not null,
  customer_email text,
  customer_phone text,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         public.booking_status not null default 'confirmed',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint bookings_range check (ends_at > starts_at)
);

create index bookings_staff_starts_idx  on public.bookings(staff_id, starts_at);
create index bookings_tenant_starts_idx on public.bookings(tenant_id, starts_at);

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

-- ============================================================
-- create_booking() — el corazón del motor
--
-- Crea una reserva de forma SEGURA frente a concurrencia. El cliente
-- de la página pública NO está autenticado, por eso es SECURITY DEFINER
-- (en 0004 se le da grant a anon). Toda la validación vive acá adentro:
-- nadie inserta en bookings "a mano".
--
-- Anti-doble-booking con cupo:
--   1. pg_advisory_xact_lock por profesional → serializa las reservas
--      de ESE staff dentro de la transacción. Sin esto, dos clientes
--      leen "queda 1 lugar" a la vez y entran los dos. Race condition.
--   2. Si la franja se solapa con OTRA sesión del profesional → ocupado.
--   3. Si es la MISMA sesión (mismo servicio + mismo inicio) y ya se
--      llegó al cupo → sin lugar.
-- ============================================================
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
