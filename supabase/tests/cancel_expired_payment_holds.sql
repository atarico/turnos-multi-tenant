-- ============================================================
-- Test SQL para 20261004120003_cancel_expired_payment_holds.sql
--
-- Misma convención que `payment_hold_resolution.sql`: assertions con
-- `do $$ ... raise exception ... $$`, todo en una transacción con ROLLBACK, y
-- el bloque de permisos cambia de rol con `set local role` (correr como
-- superusuario no probaría nada: el owner saltea los grants).
--
-- Nada de esto usa `auth.users`: los turnos se insertan directo, sin sesión.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cancel_expired_payment_holds.sql
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
    values ('Vencidos', 'expired-holds-test', 'pro', 'AR', 'UTC') returning id into v_tenant;
  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_tenant, 'Corte', 30, 1000, 'ARS') returning id into v_service;
  insert into public.staff (tenant_id, name) values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.staff_services (staff_id, service_id) values (v_staff, v_service);

  insert into t_ids values (
    v_tenant, v_service, v_staff, date_trunc('day', now() + interval '7 days')
  );
end $$;

-- Turno directo (como superusuario) en el estado que pide el caso.
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
    starts_at, ends_at, status, payment_status, payment_expires_at,
    price_cents, currency
  ) values (
    t.tenant_id, t.staff_id, t.service_id, 'Cliente',
    t.base + make_interval(hours => p_slot), t.base + make_interval(hours => p_slot, mins => 30),
    p_status, p_payment, p_expires,
    1000, 'ARS'
  ) returning id into v_id;
  return v_id;
end $$;

create temporary table t_cases (name text primary key, id uuid) on commit drop;
grant all on t_cases to public;

-- ------------------------------------------------------------
-- Caso 1: cancela los vencidos y SÓLO esos; devuelve la cantidad.
-- ------------------------------------------------------------
do $$
declare
  v_count int; b public.bookings; r record;
begin
  insert into t_cases values
    ('expired_a',  pg_temp.mk_booking('pending',   'awaiting',     now() - interval '1 minute', 1)),
    ('expired_b',  pg_temp.mk_booking('pending',   'awaiting',     now() - interval '2 hours',  2)),
    ('live',       pg_temp.mk_booking('pending',   'awaiting',     now() + interval '10 minutes', 3)),
    ('paid',       pg_temp.mk_booking('confirmed', 'paid',         null, 4)),
    ('free',       pg_temp.mk_booking('pending',   'not_required', null, 5)),
    ('cancelled',  pg_temp.mk_booking('cancelled', 'awaiting',     now() - interval '1 hour', 6));

  set local role service_role;
  v_count := public.cancel_expired_payment_holds();
  reset role;

  if v_count <> 2 then
    raise exception 'CASO 1: esperaba 2 cancelados, devolvió %.', v_count;
  end if;

  for r in select name, id from t_cases loop
    select * into b from public.bookings where id = r.id;
    if r.name in ('expired_a', 'expired_b') then
      -- Cancelado, pero el pago sigue 'awaiting': un pago tardío (T5) tiene
      -- que ver que este turno SÍ esperaba plata.
      if b.status <> 'cancelled' or b.payment_status <> 'awaiting' then
        raise exception 'CASO 1: % debía quedar cancelled/awaiting, dio %/%.',
          r.name, b.status, b.payment_status;
      end if;
    elsif r.name = 'live' then
      if b.status <> 'pending' or b.payment_status <> 'awaiting' then
        raise exception 'CASO 1: el hold vigente se tocó (%/%).', b.status, b.payment_status;
      end if;
    elsif r.name = 'paid' then
      if b.status <> 'confirmed' or b.payment_status <> 'paid' then
        raise exception 'CASO 1: el turno pagado se tocó (%/%).', b.status, b.payment_status;
      end if;
    elsif r.name = 'free' then
      if b.status <> 'pending' or b.payment_status <> 'not_required' then
        raise exception 'CASO 1: el turno sin pago se tocó (%/%).', b.status, b.payment_status;
      end if;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Caso 2: idempotente. La segunda corrida no encuentra nada.
-- ------------------------------------------------------------
do $$
declare
  v_count int;
begin
  set local role service_role;
  v_count := public.cancel_expired_payment_holds();
  reset role;
  if v_count <> 0 then
    raise exception 'CASO 2: la segunda corrida debía devolver 0, devolvió %.', v_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: un pago aprobado sobre un hold que esta función canceló termina en
-- refund_due (T5), no perdido ni confirmado.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; t t_ids;
begin
  select * into t from t_ids;
  select id into v_id from t_cases where name = 'expired_a';

  v_res := public.apply_booking_payment(t.tenant_id, v_id, 'mp-late-1', 'approved', 1000, 'ARS', now());
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 3: esperaba applied + cancelled/refund_due, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: sólo service_role. anon y authenticated no pueden ni ejecutarla.
-- ------------------------------------------------------------
do $$
declare
  v_role text; v_res text; v_id uuid; b public.bookings;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '1 minute', 10);
    v_res := 'ok';
    execute format('set local role %I', v_role);
    begin
      perform public.cancel_expired_payment_holds();
    exception when others then
      v_res := sqlstate || ': ' || sqlerrm;
    end;
    reset role;
    if v_res not like '42501:%permission denied for function%' then
      raise exception 'CASO 4: % ejecutó la función (%).', v_role, v_res;
    end if;
    select * into b from public.bookings where id = v_id;
    if b.status <> 'pending' then
      raise exception 'CASO 4: % canceló un turno.', v_role;
    end if;
    delete from public.bookings where id = v_id;
  end loop;
end $$;

rollback;
