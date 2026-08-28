-- ============================================================
-- Test SQL para 20260813120001_close_only_ended_bookings.sql
--
-- Misma convención que status_aware_catalog_delete.sql: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus propios datos,
-- todo dentro de una transacción con ROLLBACK al final.
--
-- Acá casi todos los casos esperan que la escritura FALLE, así que se
-- envuelven en `begin ... exception when ... end`: el test pasa cuando el
-- trigger levanta, y falla cuando la escritura pasó de largo.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/close_only_ended_bookings.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: cerrar un turno FUTURO rebota (completed y no_show), y el
--         estado en la tabla queda intacto.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_status  public.booking_status;
  v_closed  text;
begin
  insert into public.tenants (slug, name, country)
    values ('t-close1', 'Close 1', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente futuro', now() + interval '7 days',
       now() + interval '7 days' + interval '30 minutes', 'confirmed')
    returning id into v_booking;

  foreach v_closed in array array['completed', 'no_show'] loop
    begin
      update public.bookings
         set status = v_closed::public.booking_status
       where id = v_booking;
      raise exception 'Caso 1: marcar % un turno futuro debía rebotar', v_closed;
    exception
      when check_violation then null;  -- lo esperado
    end;
  end loop;

  select status into v_status from public.bookings where id = v_booking;
  if v_status <> 'confirmed' then
    raise exception 'Caso 1: el turno debía seguir confirmed, quedó %', v_status;
  end if;

  raise notice 'PASS: un turno futuro no se puede completar ni marcar como no asistido';
end;
$$;

-- ------------------------------------------------------------
-- Caso 2: el mismo turno, ya vencido, se cierra sin problema. El trigger
--         corta el abuso, no el uso.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_status  public.booking_status;
begin
  insert into public.tenants (slug, name, country)
    values ('t-close2', 'Close 2', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente de ayer', now() - interval '1 day',
       now() - interval '1 day' + interval '30 minutes', 'confirmed')
    returning id into v_booking;

  update public.bookings set status = 'completed' where id = v_booking;

  select status into v_status from public.bookings where id = v_booking;
  if v_status <> 'completed' then
    raise exception 'Caso 2: el turno vencido debía quedar completed, quedó %', v_status;
  end if;

  raise notice 'PASS: un turno vencido se cierra normalmente';
end;
$$;

-- ------------------------------------------------------------
-- Caso 3: cancelar y confirmar un turno futuro SIGUE funcionando. Es el
--         caso normal (el cliente avisa que no viene) y el trigger no
--         tiene por qué enterarse.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
  v_status  public.booking_status;
begin
  insert into public.tenants (slug, name, country)
    values ('t-close3', 'Close 3', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente futuro', now() + interval '3 days',
       now() + interval '3 days' + interval '30 minutes', 'pending')
    returning id into v_booking;

  update public.bookings set status = 'confirmed' where id = v_booking;
  update public.bookings set status = 'cancelled' where id = v_booking;

  select status into v_status from public.bookings where id = v_booking;
  if v_status <> 'cancelled' then
    raise exception 'Caso 3: el turno futuro debía poder cancelarse, quedó %', v_status;
  end if;

  raise notice 'PASS: confirmar y cancelar un turno futuro sigue permitido';
end;
$$;

-- ------------------------------------------------------------
-- Caso 4: la otra mitad de la invariante — no se puede mover al FUTURO un
--         turno ya cerrado. Sin esto, un UPDATE de ends_at suelto dejaría
--         la tabla exactamente en el estado que este migration prohíbe.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_booking uuid;
begin
  insert into public.tenants (slug, name, country)
    values ('t-close4', 'Close 4', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.bookings
      (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
    values
      (v_tenant, v_staff, v_service, 'Cliente de ayer', now() - interval '1 day',
       now() - interval '1 day' + interval '30 minutes', 'completed')
    returning id into v_booking;

  begin
    update public.bookings
       set starts_at = now() + interval '1 day',
           ends_at   = now() + interval '1 day' + interval '30 minutes'
     where id = v_booking;
    raise exception 'Caso 4: mover al futuro un turno completado debía rebotar';
  exception
    when check_violation then null;  -- lo esperado
  end;

  raise notice 'PASS: un turno ya cerrado no se puede mover al futuro';
end;
$$;

-- ------------------------------------------------------------
-- Caso 5: el INSERT directo también entra. `create_booking()` nunca crea
--         un turno cerrado, pero el trigger no depende de esa cortesía.
-- ------------------------------------------------------------
do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
begin
  insert into public.tenants (slug, name, country)
    values ('t-close5', 'Close 5', 'AR') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min)
    values (v_tenant, 'Corte', 30) returning id into v_service;
  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana') returning id into v_staff;

  begin
    insert into public.bookings
        (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status)
      values
        (v_tenant, v_staff, v_service, 'Cliente futuro', now() + interval '2 days',
         now() + interval '2 days' + interval '30 minutes', 'completed');
    raise exception 'Caso 5: insertar un turno futuro ya completado debía rebotar';
  exception
    when check_violation then null;  -- lo esperado
  end;

  raise notice 'PASS: tampoco se puede nacer completado en el futuro';
end;
$$;

rollback;
