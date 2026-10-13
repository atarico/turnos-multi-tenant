-- ============================================================
-- Test SQL para 20261004120001_payment_hold_resolution.sql
--
-- Misma convención que `customer_payments_foundation.sql`: assertions con
-- `do $$ ... raise exception ... $$`, todo en una transacción con ROLLBACK, y
-- los bloques de permisos cambian de rol con `set local role`. Correr como
-- superusuario no probaría nada: el owner saltea los grants.
--
-- Cada rechazo se atrapa por SQLSTATE *y* por el mensaje, así un andamio roto
-- no se cuenta como "el guard funcionó"; y ningún rechazo viaja sin un control
-- positivo sobre la misma función (los casos felices de service_role).
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/payment_hold_resolution.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

create temporary table t_ids (
  tenant_id  uuid,
  service_id uuid,
  staff_id   uuid,
  base       timestamptz
) on commit drop;

do $$
declare
  v_tenant uuid; v_service uuid; v_staff uuid;
begin
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Holds', 'holds-test', 'pro', 'AR', 'UTC') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_tenant, 'Corte', 30, 1000, 'ARS') returning id into v_service;
  insert into public.staff (tenant_id, name) values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.staff_services (staff_id, service_id) values (v_staff, v_service);

  insert into t_ids values (
    v_tenant, v_service, v_staff, date_trunc('day', now() + interval '7 days')
  );
end $$;

-- Crea un turno directo (como superusuario) en el estado que pide el caso.
-- `p_slot` separa las franjas para que ningún caso dependa de otro.
create or replace function pg_temp.mk_booking(
  p_status  public.booking_status,
  p_payment public.booking_payment_status,
  p_expires timestamptz,
  p_slot    int
) returns uuid language plpgsql as $$
declare
  v_id uuid; t t_ids;
begin
  select * into t from t_ids;
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name,
    starts_at, ends_at, status, payment_status, payment_expires_at
  ) values (
    t.tenant_id, t.staff_id, t.service_id, 'Cliente',
    t.base + make_interval(hours => p_slot), t.base + make_interval(hours => p_slot, mins => 30),
    p_status, p_payment, p_expires
  ) returning id into v_id;
  return v_id;
end $$;

-- Llama a una de las dos funciones como `p_role` y devuelve 'ok' o
-- '<sqlstate>: <mensaje>'. El rol se resetea siempre.
create or replace function pg_temp.try_call(
  p_fn text, p_booking uuid, p_role text
) returns text language plpgsql as $$
declare
  v_res text := 'ok';
begin
  execute format('set local role %I', p_role);
  begin
    if p_fn = 'release' then
      perform public.release_payment_hold_without_payment(p_booking);
    else
      perform public.cancel_payment_hold(p_booking);
    end if;
  exception when others then
    v_res := sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  return v_res;
end $$;

-- ------------------------------------------------------------
-- Caso 1: release de un hold vigente → confirmed / not_required / sin vencimiento.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings;
begin
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 1);
  v_res := pg_temp.try_call('release', v_id, 'service_role');
  if v_res <> 'ok' then
    raise exception 'CASO 1: el release de un hold vigente falló: %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'confirmed' or b.payment_status <> 'not_required' or b.payment_expires_at is not null then
    raise exception 'CASO 1: esperaba confirmed/not_required/null, dio %/%/%.',
      b.status, b.payment_status, b.payment_expires_at;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: el release se niega, cada uno por su motivo.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings;
begin
  -- 2a. Hold vencido: no se puede liberar sin pago (otro pudo tomar la franja).
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '1 minute', 2);
  v_res := pg_temp.try_call('release', v_id, 'service_role');
  if v_res not like 'P0001:%venci%' then
    raise exception 'CASO 2a: un hold vencido debía rechazarse como vencido, dio %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'pending' or b.payment_status <> 'awaiting' then
    raise exception 'CASO 2a: el rechazo tocó la fila (%/%).', b.status, b.payment_status;
  end if;

  -- 2b. Un turno que no espera pago (el caso de siempre).
  v_id := pg_temp.mk_booking('confirmed', 'not_required', null, 3);
  v_res := pg_temp.try_call('release', v_id, 'service_role');
  if v_res not like 'P0001:%no espera%' then
    raise exception 'CASO 2b: un turno sin pago debía rechazarse, dio %.', v_res;
  end if;

  -- 2c. Un turno ya pagado.
  v_id := pg_temp.mk_booking('confirmed', 'paid', null, 4);
  v_res := pg_temp.try_call('release', v_id, 'service_role');
  if v_res not like 'P0001:%no espera%' then
    raise exception 'CASO 2c: un turno pagado debía rechazarse, dio %.', v_res;
  end if;

  -- 2d. Un hold que ya se canceló: no se resucita confirmándolo.
  v_id := pg_temp.mk_booking('cancelled', 'awaiting', now() + interval '10 minutes', 5);
  v_res := pg_temp.try_call('release', v_id, 'service_role');
  if v_res not like 'P0001:%no espera%' then
    raise exception 'CASO 2d: un hold cancelado debía rechazarse, dio %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'cancelled' then
    raise exception 'CASO 2d: el rechazo resucitó el turno (%).', b.status;
  end if;

  -- 2e. Un turno que no existe: error distinto (P0002).
  v_res := pg_temp.try_call('release', gen_random_uuid(), 'service_role');
  if v_res not like 'P0002:%' then
    raise exception 'CASO 2e: un turno inexistente debía dar P0002, dio %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: cancel de un hold → cancelled, y el pago queda 'awaiting'.
--
-- Se deja 'awaiting' y no 'not_required' a propósito: un pago tardío sobre un
-- hold ya cancelado (T5) necesita ver que ese turno SÍ esperaba plata para
-- marcarla a devolver. Los CHECK de T1 lo permiten (`awaiting` sólo exige
-- vencimiento, y sólo prohíbe 'confirmed').
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings;
begin
  -- 3a. Hold vigente.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 6);
  v_res := pg_temp.try_call('cancel', v_id, 'service_role');
  if v_res <> 'ok' then
    raise exception 'CASO 3a: el cancel de un hold vigente falló: %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'cancelled' or b.payment_status <> 'awaiting' or b.payment_expires_at is null then
    raise exception 'CASO 3a: esperaba cancelled/awaiting con vencimiento, dio %/%/%.',
      b.status, b.payment_status, b.payment_expires_at;
  end if;

  -- 3b. Hold vencido: también se cancela (liberar la fila es lo que se quiere).
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '1 minute', 7);
  v_res := pg_temp.try_call('cancel', v_id, 'service_role');
  if v_res <> 'ok' then
    raise exception 'CASO 3b: el cancel de un hold vencido falló: %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'cancelled' then
    raise exception 'CASO 3b: esperaba cancelled, dio %.', b.status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: el cancel se niega fuera de un hold.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings;
begin
  -- 4a. Un turno que no espera pago NO se cancela por acá.
  v_id := pg_temp.mk_booking('confirmed', 'not_required', null, 8);
  v_res := pg_temp.try_call('cancel', v_id, 'service_role');
  if v_res not like 'P0001:%no espera%' then
    raise exception 'CASO 4a: un turno sin pago debía rechazarse, dio %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'confirmed' then
    raise exception 'CASO 4a: el rechazo cambió el turno (%).', b.status;
  end if;

  -- 4b. Uno pagado tampoco: cancelarlo pierde plata (eso es T7).
  v_id := pg_temp.mk_booking('confirmed', 'paid', null, 9);
  v_res := pg_temp.try_call('cancel', v_id, 'service_role');
  if v_res not like 'P0001:%no espera%' then
    raise exception 'CASO 4b: un turno pagado debía rechazarse, dio %.', v_res;
  end if;

  -- 4c. Un hold ya cancelado: no hay nada que resolver.
  v_id := pg_temp.mk_booking('cancelled', 'awaiting', now() + interval '10 minutes', 10);
  v_res := pg_temp.try_call('cancel', v_id, 'service_role');
  if v_res not like 'P0001:%no espera%' then
    raise exception 'CASO 4c: un hold ya cancelado debía rechazarse, dio %.', v_res;
  end if;

  -- 4d. Inexistente.
  v_res := pg_temp.try_call('cancel', gen_random_uuid(), 'service_role');
  if v_res not like 'P0002:%' then
    raise exception 'CASO 4d: un turno inexistente debía dar P0002, dio %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: sólo service_role las ejecuta. Control positivo: con service_role
--         las mismas llamadas SÍ corren (casos 1 y 3).
-- ------------------------------------------------------------
do $$
declare
  v_role text; v_fn text; v_id uuid; v_res text; b public.bookings;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_fn in array array['release', 'cancel'] loop
      v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 11);
      v_res := pg_temp.try_call(v_fn, v_id, v_role);
      if v_res not like '42501:%permission denied for function%' then
        raise exception 'CASO 5: % ejecutó % (%).', v_role, v_fn, v_res;
      end if;
      select * into b from public.bookings where id = v_id;
      if b.status <> 'pending' or b.payment_status <> 'awaiting' then
        raise exception 'CASO 5: % tocó la fila con %.', v_role, v_fn;
      end if;
      delete from public.bookings where id = v_id;
    end loop;
  end loop;
end $$;

rollback;
