-- ============================================================
-- Test SQL para 20260901120001_count_period_bookings.sql
--
-- Misma convención que coupons.sql: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus datos, todo en una
-- transacción con ROLLBACK.
--
-- Lo que más se cuida acá es la ELECCIÓN de columna. La función cuenta por
-- `created_at` y no por `starts_at`, y esa diferencia es invisible en una
-- prueba feliz: si todos los turnos se cargan y ocurren dentro de la misma
-- ventana, las dos versiones dan el mismo número. Los casos 2 y 3 existen
-- para que un cambio a `starts_at` ROMPA en vez de pasar.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/count_period_bookings.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Andamio: un negocio con un servicio y un profesional, que es
-- lo mínimo que `bookings` exige por sus foreign keys.
-- ------------------------------------------------------------
create temporary table t_ids (
  tenant_id  uuid,
  service_id uuid,
  staff_id   uuid
) on commit drop;

do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
begin
  insert into public.tenants (name, slug, plan, country)
    values ('Techo de Turnos', 'techo-de-turnos-test', 'basico', 'AR')
    returning id into v_tenant;

  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_tenant, 'Corte', 30, 1000, 'ARS')
    returning id into v_service;

  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana')
    returning id into v_staff;

  insert into t_ids values (v_tenant, v_service, v_staff);
end $$;

-- ------------------------------------------------------------
-- Caso 1: cuenta lo cargado dentro de la ventana y nada más.
-- ------------------------------------------------------------
do $$
declare
  v  record;
  n  bigint;
begin
  select * into v from t_ids;

  -- Dos dentro de la ventana, uno antes, uno después.
  insert into public.bookings
    (tenant_id, service_id, staff_id, customer_name, customer_phone,
     starts_at, ends_at, price_cents, currency, created_at)
  values
    (v.tenant_id, v.service_id, v.staff_id, 'A', '111',
     '2026-09-10 14:00+00', '2026-09-10 14:30+00', 1000, 'ARS', '2026-09-05 10:00+00'),
    (v.tenant_id, v.service_id, v.staff_id, 'B', '222',
     '2026-09-11 14:00+00', '2026-09-11 14:30+00', 1000, 'ARS', '2026-09-06 10:00+00'),
    (v.tenant_id, v.service_id, v.staff_id, 'C', '333',
     '2026-09-12 14:00+00', '2026-09-12 14:30+00', 1000, 'ARS', '2026-08-31 23:59+00'),
    (v.tenant_id, v.service_id, v.staff_id, 'D', '444',
     '2026-09-13 14:00+00', '2026-09-13 14:30+00', 1000, 'ARS', '2026-10-01 00:00+00');

  select public.count_period_bookings(
    v.tenant_id, '2026-09-01 00:00+00', '2026-10-01 00:00+00') into n;

  if n <> 2 then
    raise exception 'CASO 1: contó % en vez de 2.', n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: EL CASO QUE DEFINE LA FUNCIÓN.
--
-- Un turno CARGADO dentro del período pero con fecha muy
-- posterior tiene que contar igual. Es exactamente el abuso que
-- el techo existe para ver: cargar de golpe miles de turnos con
-- fecha del año que viene. Contando por `starts_at` este turno
-- valdría cero y el abuso sería invisible.
-- ------------------------------------------------------------
do $$
declare
  v record;
  n bigint;
begin
  select * into v from t_ids;

  insert into public.bookings
    (tenant_id, service_id, staff_id, customer_name, customer_phone,
     starts_at, ends_at, price_cents, currency, created_at)
  values
    (v.tenant_id, v.service_id, v.staff_id, 'Futuro', '555',
     '2027-06-01 14:00+00', '2027-06-01 14:30+00', 1000, 'ARS', '2026-09-15 10:00+00');

  select public.count_period_bookings(
    v.tenant_id, '2026-09-01 00:00+00', '2026-10-01 00:00+00') into n;

  if n <> 3 then
    raise exception
      'CASO 2: contó % en vez de 3. ¿Está contando por starts_at?', n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: el espejo del anterior.
--
-- Un turno que OCURRE en el período pero se cargó antes NO
-- cuenta contra este período: ya se contó contra aquel.
-- ------------------------------------------------------------
do $$
declare
  v record;
  n bigint;
begin
  select * into v from t_ids;

  insert into public.bookings
    (tenant_id, service_id, staff_id, customer_name, customer_phone,
     starts_at, ends_at, price_cents, currency, created_at)
  values
    (v.tenant_id, v.service_id, v.staff_id, 'Viejo', '666',
     '2026-09-20 14:00+00', '2026-09-20 14:30+00', 1000, 'ARS', '2026-07-01 10:00+00');

  select public.count_period_bookings(
    v.tenant_id, '2026-09-01 00:00+00', '2026-10-01 00:00+00') into n;

  if n <> 3 then
    raise exception
      'CASO 3: contó % en vez de 3. Un turno cargado en julio no gasta el cupo de septiembre.', n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: un turno cancelado sigue contando.
--
-- Ya ocupó su fila y ya consumió sistema. Descontarlo dejaría
-- una vía para vaciar el contador: cargar mil y cancelarlos.
-- ------------------------------------------------------------
do $$
declare
  v record;
  n bigint;
begin
  select * into v from t_ids;

  insert into public.bookings
    (tenant_id, service_id, staff_id, customer_name, customer_phone,
     starts_at, ends_at, price_cents, currency, created_at, status)
  values
    (v.tenant_id, v.service_id, v.staff_id, 'Cancelado', '777',
     '2026-09-21 14:00+00', '2026-09-21 14:30+00', 1000, 'ARS',
     '2026-09-16 10:00+00', 'cancelled');

  select public.count_period_bookings(
    v.tenant_id, '2026-09-01 00:00+00', '2026-10-01 00:00+00') into n;

  if n <> 4 then
    raise exception
      'CASO 4: contó % en vez de 4. Un cancelado ya gastó su fila.', n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: los turnos de OTRO negocio no entran.
--
-- La RLS es la que aísla en producción, pero la función recibe
-- un uuid: si el `where` sobre tenant_id se perdiera, el número
-- se mezclaría entre negocios sin que ninguna policy lo note.
-- ------------------------------------------------------------
do $$
declare
  v        record;
  v_other  uuid;
  v_svc    uuid;
  v_stf    uuid;
  n        bigint;
begin
  select * into v from t_ids;

  insert into public.tenants (name, slug, plan, country)
    values ('Otro Negocio', 'otro-negocio-test', 'basico', 'AR')
    returning id into v_other;
  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_other, 'Color', 60, 2000, 'ARS') returning id into v_svc;
  insert into public.staff (tenant_id, name)
    values (v_other, 'Beto') returning id into v_stf;

  insert into public.bookings
    (tenant_id, service_id, staff_id, customer_name, customer_phone,
     starts_at, ends_at, price_cents, currency, created_at)
  values
    (v_other, v_svc, v_stf, 'Ajeno', '888',
     '2026-09-22 14:00+00', '2026-09-22 14:30+00', 2000, 'ARS', '2026-09-17 10:00+00');

  select public.count_period_bookings(
    v.tenant_id, '2026-09-01 00:00+00', '2026-10-01 00:00+00') into n;

  if n <> 4 then
    raise exception 'CASO 5: contó % en vez de 4. Se filtraron turnos de otro negocio.', n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: un período sin nada cargado vale cero, no null.
--
-- `count(*)` sobre cero filas devuelve 0, pero si alguien
-- cambiara la función a `sum(...)` devolvería null, y null
-- comparado contra el techo no es mayor ni menor: el aviso
-- desaparecería en silencio.
-- ------------------------------------------------------------
do $$
declare
  v record;
  n bigint;
begin
  select * into v from t_ids;

  select public.count_period_bookings(
    v.tenant_id, '2025-01-01 00:00+00', '2025-02-01 00:00+00') into n;

  if n is null then
    raise exception 'CASO 6: devolvió null. Un período vacío vale cero.';
  end if;
  if n <> 0 then
    raise exception 'CASO 6: contó % en vez de 0.', n;
  end if;
end $$;

rollback;
