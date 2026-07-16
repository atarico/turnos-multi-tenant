-- ============================================================
-- 0004 — RLS del motor de turnos + lectura pública
--
-- Dos mundos conviven sobre las mismas tablas:
--   · PANEL (autenticado): el negocio gestiona staff, horarios y su
--     agenda. Aislado por tenant con auth_tenant_ids().
--   · PÁGINA PÚBLICA /[slug] (anónimo): el cliente sólo LEE datos de
--     reserva. No toca las tablas base: lee VISTAS con columnas seguras
--     y reserva vía create_booking() (SECURITY DEFINER).
-- ============================================================

alter table public.staff              enable row level security;
alter table public.staff_services     enable row level security;
alter table public.staff_availability enable row level security;
alter table public.bookings           enable row level security;

-- ---------- staff ----------
-- El negocio gestiona (CRUD completo) sus profesionales.
create policy "staff_all_members"
  on public.staff for all
  using (tenant_id in (select public.auth_tenant_ids()))
  with check (tenant_id in (select public.auth_tenant_ids()));

-- ---------- staff_services ----------
-- Se gestiona a través del profesional: si el staff es de un negocio
-- mío, puedo asignar/quitar sus servicios.
create policy "staff_services_all_members"
  on public.staff_services for all
  using (
    staff_id in (
      select id from public.staff
      where tenant_id in (select public.auth_tenant_ids())
    )
  )
  with check (
    staff_id in (
      select id from public.staff
      where tenant_id in (select public.auth_tenant_ids())
    )
  );

-- ---------- staff_availability ----------
create policy "staff_availability_all_members"
  on public.staff_availability for all
  using (
    staff_id in (
      select id from public.staff
      where tenant_id in (select public.auth_tenant_ids())
    )
  )
  with check (
    staff_id in (
      select id from public.staff
      where tenant_id in (select public.auth_tenant_ids())
    )
  );

-- ---------- bookings ----------
-- El negocio VE y gestiona su agenda (confirmar, cancelar, no-show).
-- El INSERT NO se habilita por policy: pasa siempre por create_booking(),
-- que valida cupo y disponibilidad. Así nadie inserta saltándose el motor.
create policy "bookings_select_members"
  on public.bookings for select
  using (tenant_id in (select public.auth_tenant_ids()));

create policy "bookings_update_members"
  on public.bookings for update
  using (tenant_id in (select public.auth_tenant_ids()))
  with check (tenant_id in (select public.auth_tenant_ids()));

create policy "bookings_delete_members"
  on public.bookings for delete
  using (tenant_id in (select public.auth_tenant_ids()));

-- ============================================================
-- Lectura PÚBLICA (anónima) para la página de reservas /[slug]
--
-- Las vistas corren con privilegios de su dueño (NO security_invoker),
-- así saltean la RLS de las tablas base a propósito. Por eso exponen
-- SÓLO columnas seguras y SÓLO filas activas: nada de plan, país,
-- ni datos de clientes.
-- ============================================================

-- Branding del negocio (sin country ni plan).
create view public.public_tenants
with (security_invoker = false) as
  select id, slug, name, timezone, brand_color, logo_url
  from public.tenants;

-- Servicios ofrecidos (sólo activos).
create view public.public_services
with (security_invoker = false) as
  select id, tenant_id, name, description, duration_min,
         price_cents, currency, capacity
  from public.services
  where active;

-- Profesionales (sólo activos).
create view public.public_staff
with (security_invoker = false) as
  select id, tenant_id, name, role, avatar_url
  from public.staff
  where active;

-- Qué servicio ofrece cada profesional (sólo de staff activo).
create view public.public_staff_services
with (security_invoker = false) as
  select ss.staff_id, ss.service_id
  from public.staff_services ss
  join public.staff s on s.id = ss.staff_id
  where s.active;

-- Horario semanal de cada profesional activo.
create view public.public_availability
with (security_invoker = false) as
  select a.staff_id, a.weekday, a.start_time, a.end_time
  from public.staff_availability a
  join public.staff s on s.id = a.staff_id
  where s.active;

-- Carga de las franjas FUTURAS, sin datos del cliente: sólo qué ocupa
-- a cada profesional, para poder pintar las franjas llenas. Expone
-- service_id y starts_at para distinguir la misma sesión grupal.
create view public.public_booking_load
with (security_invoker = false) as
  select staff_id, service_id, starts_at, ends_at
  from public.bookings
  where status in ('pending', 'confirmed')
    and starts_at >= now();

-- ---------- Grants de lectura pública ----------
grant select on public.public_tenants         to anon, authenticated;
grant select on public.public_services        to anon, authenticated;
grant select on public.public_staff           to anon, authenticated;
grant select on public.public_staff_services  to anon, authenticated;
grant select on public.public_availability    to anon, authenticated;
grant select on public.public_booking_load    to anon, authenticated;

-- ---------- Reservar sin login ----------
-- El cliente anónimo crea su turno SÓLO por esta función validada.
grant execute on function public.create_booking(
  text, uuid, uuid, timestamptz, text, text, text, text
) to anon, authenticated;
