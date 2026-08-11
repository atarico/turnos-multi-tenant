-- ============================================================
-- Test SQL para 20260811120001_status_aware_catalog_delete.sql
--
-- Primer test SQL del repo — nueva convención (no hay pgTAP instalado).
-- Assertions con `do $$ ... raise exception ... $$`: cada bloque crea sus
-- propios datos (tenant/servicio/profesional/turno) para no pisarse entre
-- casos, y termina con `raise notice 'PASS: ...'` si todo salió bien.
-- Falla ruidoso: cualquier `raise exception` sin capturar corta el script
-- entero (ON_ERROR_STOP) y psql devuelve código de salida distinto de 0.
--
-- Corre TODO adentro de una transacción y hace ROLLBACK al final: es
-- seguro correrlo contra una branch DB de Supabase (o contra prod, si
-- hiciera falta) sin dejar basura de test.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/status_aware_catalog_delete.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: sólo turnos cancelled/no_show → 'deleted', el turno sobrevive
--         con su nombre congelado y service_id/staff_id en null.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_outcome public.delete_outcome;
  v_row     public.bookings;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case1', 'Case 1', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 1', now() - interval '2 days',
       now() - interval '2 days' + interval '30 minutes', 'cancelled')
    returning id into v_booking;

  select public.delete_service(v_tenant, v_service) into v_outcome;
  if v_outcome <> 'deleted' then
    raise exception 'Caso 1 (service): esperaba deleted, dio %', v_outcome;
  end if;

  select * into v_row from public.bookings where id = v_booking;
  if v_row.service_id is not null or v_row.service_name <> 'Corte' then
    raise exception 'Caso 1 (service): el turno debía sobrevivir desvinculado con service_name=Corte, quedó service_id=% service_name=%',
      v_row.service_id, v_row.service_name;
  end if;
  if exists (select 1 from public.services where id = v_service) then
    raise exception 'Caso 1 (service): el servicio debía quedar borrado';
  end if;

  select public.delete_staff(v_tenant, v_staff) into v_outcome;
  if v_outcome <> 'deleted' then
    raise exception 'Caso 1 (staff): esperaba deleted, dio %', v_outcome;
  end if;

  select * into v_row from public.bookings where id = v_booking;
  if v_row.staff_id is not null or v_row.staff_name <> 'Ana' then
    raise exception 'Caso 1 (staff): el turno debía sobrevivir desvinculado con staff_name=Ana, quedó staff_id=% staff_name=%',
      v_row.staff_id, v_row.staff_name;
  end if;
  if exists (select 1 from public.staff where id = v_staff) then
    raise exception 'Caso 1 (staff): el profesional debía quedar borrado';
  end if;

  raise notice 'PASS: cancelled-only -> deleted, nombre congelado sobrevive';
end;
$$;

-- ------------------------------------------------------------
-- Caso 2: turno 'completed' sin turnos vigentes → 'blocked_history',
--         cero escrituras (el servicio/profesional siguen vivos).
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_outcome public.delete_outcome;
  v_row     public.bookings;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case2', 'Case 2', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 2', now() - interval '5 days',
       now() - interval '5 days' + interval '30 minutes', 'completed')
    returning id into v_booking;

  select public.delete_service(v_tenant, v_service) into v_outcome;
  if v_outcome <> 'blocked_history' then
    raise exception 'Caso 2 (service): esperaba blocked_history, dio %', v_outcome;
  end if;
  if not exists (select 1 from public.services where id = v_service) then
    raise exception 'Caso 2 (service): no debía borrarse nada';
  end if;
  select * into v_row from public.bookings where id = v_booking;
  if v_row.service_id is null then
    raise exception 'Caso 2 (service): el turno no debía desvincularse';
  end if;

  select public.delete_staff(v_tenant, v_staff) into v_outcome;
  if v_outcome <> 'blocked_history' then
    raise exception 'Caso 2 (staff): esperaba blocked_history, dio %', v_outcome;
  end if;
  if not exists (select 1 from public.staff where id = v_staff) then
    raise exception 'Caso 2 (staff): no debía borrarse nada';
  end if;

  raise notice 'PASS: completed -> blocked_history, cero escrituras';
end;
$$;

-- ------------------------------------------------------------
-- Caso 3: turno 'confirmed' (vigente) → 'blocked_upcoming'.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_outcome public.delete_outcome;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case3', 'Case 3', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 3', now() + interval '2 days',
       now() + interval '2 days' + interval '30 minutes', 'confirmed');

  select public.delete_service(v_tenant, v_service) into v_outcome;
  if v_outcome <> 'blocked_upcoming' then
    raise exception 'Caso 3 (service): esperaba blocked_upcoming, dio %', v_outcome;
  end if;

  select public.delete_staff(v_tenant, v_staff) into v_outcome;
  if v_outcome <> 'blocked_upcoming' then
    raise exception 'Caso 3 (staff): esperaba blocked_upcoming, dio %', v_outcome;
  end if;

  raise notice 'PASS: confirmed -> blocked_upcoming';
end;
$$;

-- ------------------------------------------------------------
-- Caso 4: DELETE directo sobre staff (bypaseando la RPC) con un turno
--         'completed' que lo referencia -> 23503, el turno queda intacto.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_caught  boolean := false;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case4', 'Case 4', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 4', now() - interval '5 days',
       now() - interval '5 days' + interval '30 minutes', 'completed')
    returning id into v_booking;

  begin
    delete from public.staff where id = v_staff;
  exception
    when foreign_key_violation then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Caso 4: el DELETE directo debía fallar con foreign_key_violation (23503)';
  end if;
  if not exists (select 1 from public.bookings where id = v_booking) then
    raise exception 'Caso 4: el turno no debía perderse';
  end if;
  if not exists (select 1 from public.staff where id = v_staff) then
    raise exception 'Caso 4: el profesional no debía borrarse (RESTRICT tenía que frenarlo)';
  end if;

  raise notice 'PASS: DELETE directo sobre staff con turno completed -> 23503';
end;
$$;

-- ------------------------------------------------------------
-- Caso 5: el CHECK rechaza dejar service_id en null en un turno
--         'completed' (invariante: FK viva O turno terminal).
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_caught  boolean := false;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case5', 'Case 5', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 5', now() - interval '5 days',
       now() - interval '5 days' + interval '30 minutes', 'completed')
    returning id into v_booking;

  begin
    update public.bookings set service_id = null where id = v_booking;
  exception
    when check_violation then
      v_caught := true;
  end;

  if not v_caught then
    raise exception 'Caso 5: el CHECK debía rechazar service_id=null en un turno completed';
  end if;

  raise notice 'PASS: CHECK rechaza service_id=null en turno completed';
end;
$$;

-- ------------------------------------------------------------
-- Caso 6: precedencia — un mismo servicio/profesional con un turno
--         'completed' Y otro 'confirmed' a la vez -> 'blocked_upcoming'
--         gana (se chequea antes que 'blocked_history' en las RPCs).
--         Sin este caso, invertir el orden de las dos ramas seguiría
--         dando verde en los casos 2 y 3 por separado.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_outcome public.delete_outcome;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case6', 'Case 6', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;

  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 6a', now() - interval '5 days',
       now() - interval '5 days' + interval '30 minutes', 'completed');
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente 6b', now() + interval '2 days',
       now() + interval '2 days' + interval '30 minutes', 'confirmed');

  select public.delete_service(v_tenant, v_service) into v_outcome;
  if v_outcome <> 'blocked_upcoming' then
    raise exception 'Caso 6 (service): completed+confirmed a la vez debía dar blocked_upcoming (precedencia), dio %', v_outcome;
  end if;

  select public.delete_staff(v_tenant, v_staff) into v_outcome;
  if v_outcome <> 'blocked_upcoming' then
    raise exception 'Caso 6 (staff): completed+confirmed a la vez debía dar blocked_upcoming (precedencia), dio %', v_outcome;
  end if;

  raise notice 'PASS: completed + confirmed simultáneos -> blocked_upcoming gana';
end;
$$;

-- ------------------------------------------------------------
-- Caso 7: reasignación (estilo reschedule_booking) vs. renombre vs.
--         desvinculación — las tres cosas que le pueden pasar a
--         staff_name después del INSERT, cada una con el efecto
--         correcto:
--           a) UPDATE staff_id a OTRO profesional -> el nombre SIGUE
--              a la FK (re-resuelve al nombre del nuevo profesional).
--           b) Renombrar ese profesional nuevo DESPUÉS -> el turno NO
--              se entera (snapshot congelado, no un join en vivo).
--           c) Cancelar y desvincular (staff_id = null) -> el nombre
--              queda tal cual estaba, no se pierde.
-- ------------------------------------------------------------
do $$
declare
  v_tenant   uuid;
  v_service  uuid;
  v_staff_a  uuid;
  v_staff_b  uuid;
  v_booking  uuid;
  v_name     text;
begin
  insert into public.tenants (slug, name, country)
    values ('t-case7', 'Case 7', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff_a;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Beto') returning id into v_staff_b;

  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff_a, v_service, 'Cliente 7', now() + interval '2 days',
       now() + interval '2 days' + interval '30 minutes', 'confirmed')
    returning id into v_booking;

  select staff_name into v_name from public.bookings where id = v_booking;
  if v_name <> 'Ana' then
    raise exception 'Caso 7a: el INSERT debía snapshotear staff_name=Ana, dio %', v_name;
  end if;

  -- a) Reasignación: mismo camino que reschedule_booking() (UPDATE de
  --    staff_id sobre un turno vigente).
  update public.bookings set staff_id = v_staff_b where id = v_booking;

  select staff_name into v_name from public.bookings where id = v_booking;
  if v_name <> 'Beto' then
    raise exception 'Caso 7a: reasignar staff_id debía actualizar staff_name a Beto, dio %', v_name;
  end if;

  -- b) Renombre del profesional YA asignado: el turno no se entera.
  update public.staff set name = 'Beto Nuevo' where id = v_staff_b;

  select staff_name into v_name from public.bookings where id = v_booking;
  if v_name <> 'Beto' then
    raise exception 'Caso 7b: renombrar al profesional no debía tocar el snapshot, dio %', v_name;
  end if;

  -- c) Desvinculación: cancelar (para cumplir el CHECK) y poner
  --    staff_id en null. El nombre congelado tiene que sobrevivir.
  update public.bookings set status = 'cancelled' where id = v_booking;
  update public.bookings set staff_id = null where id = v_booking;

  select staff_name into v_name from public.bookings where id = v_booking;
  if v_name <> 'Beto' then
    raise exception 'Caso 7c: desvincular staff_id no debía tocar el snapshot, dio %', v_name;
  end if;

  raise notice 'PASS: reasignación sigue la FK, renombre y desvinculación no tocan el snapshot';
end;
$$;

rollback;
