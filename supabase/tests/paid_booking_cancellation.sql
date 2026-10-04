-- ============================================================
-- Test SQL para 20261004120004_paid_booking_cancellation.sql
--
-- Misma convención que `cancel_expired_payment_holds.sql`: assertions con
-- `do $$ ... raise exception ... $$`, todo en una transacción con ROLLBACK, y
-- los casos de permisos cambian de rol con `set local role` más el claim `sub`
-- del JWT (correr como superusuario no probaría nada: el owner saltea grants y
-- RLS). Los usuarios de `auth.users` llevan id explícito.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/paid_booking_cancellation.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

create temporary table t_ids (
  tenant_id  uuid,
  other_id   uuid,
  service_id uuid,
  staff_id   uuid,
  owner_u    uuid,
  admin_u    uuid,
  staff_u    uuid,
  outsider_u uuid,
  base       timestamptz
) on commit drop;
grant all on t_ids to public;

do $$
declare
  v_tenant uuid; v_other uuid; v_service uuid; v_staff uuid;
  v_owner uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_staffu uuid := gen_random_uuid();
  v_out uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_owner, 'owner-pc@test.com'), (v_admin, 'admin-pc@test.com'),
    (v_staffu, 'staff-pc@test.com'), (v_out, 'out-pc@test.com');

  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Pagados', 'paid-cancel-test', 'pro', 'AR', 'UTC') returning id into v_tenant;
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Otro', 'paid-cancel-other', 'pro', 'AR', 'UTC') returning id into v_other;
  insert into public.memberships (user_id, tenant_id, role) values
    (v_owner, v_tenant, 'owner'), (v_admin, v_tenant, 'admin'), (v_staffu, v_tenant, 'staff'),
    (v_out, v_other, 'owner');

  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_tenant, 'Corte', 30, 1000, 'ARS') returning id into v_service;
  insert into public.staff (tenant_id, name) values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.staff_services (staff_id, service_id) values (v_staff, v_service);

  insert into t_ids values (
    v_tenant, v_other, v_service, v_staff, v_owner, v_admin, v_staffu, v_out,
    date_trunc('day', now() + interval '7 days')
  );
end $$;

create or replace function pg_temp.mk_booking(
  p_status  public.booking_status,
  p_payment public.booking_payment_status,
  p_slot    int
) returns uuid language plpgsql as $$
declare
  v_id uuid; t t_ids;
begin
  select * into t from t_ids;
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name,
    starts_at, ends_at, status, payment_status, price_cents, currency
  ) values (
    t.tenant_id, t.staff_id, t.service_id, 'Cliente',
    t.base + make_interval(hours => p_slot), t.base + make_interval(hours => p_slot, mins => 30),
    p_status, p_payment, 1000, 'ARS'
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function pg_temp.mk_payment(
  p_booking uuid, p_status text, p_mp text
) returns uuid language plpgsql as $$
declare
  v_id uuid; t t_ids;
begin
  select * into t from t_ids;
  insert into public.booking_payments (booking_id, tenant_id, mp_payment_id, status, amount_cents, currency)
  values (p_booking, t.tenant_id, p_mp, p_status, 1000, 'ARS') returning id into v_id;
  return v_id;
end $$;

-- Ejecuta una sentencia como `authenticated` con el usuario dado y devuelve
-- 'ok' o 'SQLSTATE: mensaje'. El rol se restaura siempre.
create or replace function pg_temp.try_as(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare
  v_res text := 'ok';
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  set local role authenticated;
  begin
    execute p_sql;
  exception when others then
    v_res := sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  return v_res;
end $$;

-- ------------------------------------------------------------
-- Caso 1: el CHECK frena el cancel directo de un turno pagado, incluso para un
-- miembro con su rol y su JWT; un turno no pagado sí se cancela.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_paid uuid; v_free uuid; v_res text;
begin
  select * into t from t_ids;
  v_paid := pg_temp.mk_booking('confirmed', 'paid', 1);
  v_free := pg_temp.mk_booking('pending', 'not_required', 2);

  v_res := pg_temp.try_as(t.owner_u,
    format('update public.bookings set status = %L where id = %L', 'cancelled', v_paid));
  if v_res not like '23514:%' then
    raise exception 'CASO 1: el cancel directo de un pagado debía dar 23514, dio %.', v_res;
  end if;
  if (select status from public.bookings where id = v_paid) <> 'confirmed' then
    raise exception 'CASO 1: el turno pagado cambió de estado.';
  end if;

  v_res := pg_temp.try_as(t.owner_u,
    format('update public.bookings set status = %L where id = %L', 'cancelled', v_free));
  if v_res <> 'ok' then
    raise exception 'CASO 1: cancelar un turno sin pago debía andar, dio %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: cancel_paid_booking, camino feliz. Un solo UPDATE deja
-- cancelled + refund_due (el CHECK evalúa la fila ya cambiada).
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_res text; b public.bookings;
begin
  select * into t from t_ids;
  v_b := pg_temp.mk_booking('confirmed', 'paid', 3);

  v_res := pg_temp.try_as(t.owner_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res <> 'ok' then
    raise exception 'CASO 2: cancel_paid_booking falló: %.', v_res;
  end if;

  select * into b from public.bookings where id = v_b;
  if b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 2: esperaba cancelled/refund_due, dio %/%.', b.status, b.payment_status;
  end if;

  -- Un turno pendiente pero pagado también entra.
  v_b := pg_temp.mk_booking('pending', 'paid', 4);
  v_res := pg_temp.try_as(t.owner_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res <> 'ok' then
    raise exception 'CASO 2: un pagado pendiente debía poder cancelarse: %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: permisos de cancel_paid_booking. Un miembro `staff` puede (hoy
-- cancelar es un UPDATE que la RLS le deja a cualquier miembro); un
-- extraño no; anon no ejecuta.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_res text;
begin
  select * into t from t_ids;

  v_b := pg_temp.mk_booking('confirmed', 'paid', 5);
  v_res := pg_temp.try_as(t.staff_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res <> 'ok' then
    raise exception 'CASO 3: un miembro staff debía poder cancelar: %.', v_res;
  end if;

  v_b := pg_temp.mk_booking('confirmed', 'paid', 6);
  v_res := pg_temp.try_as(t.outsider_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res not like '42501:%' then
    raise exception 'CASO 3: un extraño debía recibir 42501, dio %.', v_res;
  end if;
  if (select status from public.bookings where id = v_b) <> 'confirmed' then
    raise exception 'CASO 3: el extraño tocó el turno.';
  end if;

  v_res := pg_temp.try_as(null, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res not like '42501:%' then
    raise exception 'CASO 3: sin sesión debía dar 42501, dio %.', v_res;
  end if;

  if not has_function_privilege('authenticated', 'public.cancel_paid_booking(uuid)', 'execute') then
    raise exception 'CASO 3: authenticated debía poder ejecutarla.';
  end if;
  if has_function_privilege('anon', 'public.cancel_paid_booking(uuid)', 'execute') then
    raise exception 'CASO 3: anon NO debía poder ejecutarla.';
  end if;
  if has_function_privilege('public', 'public.cancel_paid_booking(uuid)', 'execute') then
    raise exception 'CASO 3: public NO debía poder ejecutarla.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: estados que cancel_paid_booking rechaza, con errores distintos.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_res text;
begin
  select * into t from t_ids;

  -- No pagado.
  v_b := pg_temp.mk_booking('pending', 'not_required', 7);
  v_res := pg_temp.try_as(t.owner_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res not like 'P0001:%no está pagado%' then
    raise exception 'CASO 4: un no pagado debía dar "no está pagado", dio %.', v_res;
  end if;

  -- Pagado pero ya cerrado (completado); el turno tiene que haber terminado (trigger de cierre), por eso la franja es pasada.
  v_b := pg_temp.mk_booking('completed', 'paid', -192);
  v_res := pg_temp.try_as(t.owner_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res not like 'P0001:%ya está cerrado%' then
    raise exception 'CASO 4: un completado debía dar "ya está cerrado", dio %.', v_res;
  end if;

  -- Ya cancelado y a devolver: no se cancela dos veces.
  v_b := pg_temp.mk_booking('cancelled', 'refund_due', 9);
  v_res := pg_temp.try_as(t.owner_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res not like 'P0001:%ya está cerrado%' then
    raise exception 'CASO 4: un cancelado debía dar "ya está cerrado", dio %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: mark_payment_refunded, rama del pago EXTRA (fila 'refund_due'): la
-- fila pasa a 'refunded' y el turno NO se toca.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_p uuid; v_res text; b public.bookings;
begin
  select * into t from t_ids;
  v_b := pg_temp.mk_booking('confirmed', 'paid', 10);
  v_p := pg_temp.mk_payment(v_b, 'refund_due', 'mp-extra-1');

  v_res := pg_temp.try_as(t.owner_u, format('select public.mark_payment_refunded(%L)', v_p));
  if v_res <> 'ok' then
    raise exception 'CASO 5: mark_payment_refunded falló: %.', v_res;
  end if;
  if (select status from public.booking_payments where id = v_p) <> 'refunded' then
    raise exception 'CASO 5: la fila debía quedar refunded.';
  end if;
  select * into b from public.bookings where id = v_b;
  if b.status <> 'confirmed' or b.payment_status <> 'paid' then
    raise exception 'CASO 5: el turno no debía tocarse (%/%).', b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: rama del pago PRINCIPAL ('approved' de un turno 'refund_due'): la fila
-- Y el turno pasan a refunded. Un admin también puede.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_p uuid; v_res text; b public.bookings;
begin
  select * into t from t_ids;
  v_b := pg_temp.mk_booking('cancelled', 'refund_due', 11);
  v_p := pg_temp.mk_payment(v_b, 'approved', 'mp-main-1');

  v_res := pg_temp.try_as(t.admin_u, format('select public.mark_payment_refunded(%L)', v_p));
  if v_res <> 'ok' then
    raise exception 'CASO 6: un admin debía poder marcar la devolución: %.', v_res;
  end if;
  if (select status from public.booking_payments where id = v_p) <> 'refunded' then
    raise exception 'CASO 6: la fila debía quedar refunded.';
  end if;
  select * into b from public.bookings where id = v_b;
  if b.status <> 'cancelled' or b.payment_status <> 'refunded' then
    raise exception 'CASO 6: esperaba cancelled/refunded, dio %/%.', b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: permisos y estados de mark_payment_refunded.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_p uuid; v_res text;
begin
  select * into t from t_ids;
  v_b := pg_temp.mk_booking('cancelled', 'refund_due', 12);
  v_p := pg_temp.mk_payment(v_b, 'approved', 'mp-main-2');

  -- staff: refused. El pago no cambia.
  v_res := pg_temp.try_as(t.staff_u, format('select public.mark_payment_refunded(%L)', v_p));
  if v_res not like '42501:%' then
    raise exception 'CASO 7: un staff debía recibir 42501, dio %.', v_res;
  end if;
  -- no miembro de ese negocio: el mismo error.
  v_res := pg_temp.try_as(t.outsider_u, format('select public.mark_payment_refunded(%L)', v_p));
  if v_res not like '42501:%' then
    raise exception 'CASO 7: un extraño debía recibir 42501, dio %.', v_res;
  end if;
  if (select status from public.booking_payments where id = v_p) <> 'approved'
     or (select payment_status from public.bookings where id = v_b) <> 'refund_due' then
    raise exception 'CASO 7: un rechazo cambió datos.';
  end if;

  -- Estado equivocado: 'approved' pero el turno sigue 'paid' (no hay nada a devolver).
  v_b := pg_temp.mk_booking('confirmed', 'paid', 13);
  v_p := pg_temp.mk_payment(v_b, 'approved', 'mp-main-3');
  v_res := pg_temp.try_as(t.owner_u, format('select public.mark_payment_refunded(%L)', v_p));
  if v_res not like 'P0001:%no está pendiente de devolución%' then
    raise exception 'CASO 7: un pago sin devolución pendiente debía dar P0001, dio %.', v_res;
  end if;

  -- Ya devuelto: no se marca dos veces.
  v_b := pg_temp.mk_booking('cancelled', 'refunded', 14);
  v_p := pg_temp.mk_payment(v_b, 'refunded', 'mp-main-4');
  v_res := pg_temp.try_as(t.owner_u, format('select public.mark_payment_refunded(%L)', v_p));
  if v_res not like 'P0001:%no está pendiente de devolución%' then
    raise exception 'CASO 7: un ya devuelto debía dar P0001, dio %.', v_res;
  end if;

  -- Pago inexistente: indistinguible de "sin permiso".
  v_res := pg_temp.try_as(t.owner_u,
    format('select public.mark_payment_refunded(%L)', gen_random_uuid()));
  if v_res not like '42501:%' then
    raise exception 'CASO 7: un id inexistente debía dar 42501, dio %.', v_res;
  end if;

  if not has_function_privilege('authenticated', 'public.mark_payment_refunded(uuid)', 'execute') then
    raise exception 'CASO 7: authenticated debía poder ejecutarla.';
  end if;
  if has_function_privilege('anon', 'public.mark_payment_refunded(uuid)', 'execute') then
    raise exception 'CASO 7: anon NO debía poder ejecutarla.';
  end if;
  if has_function_privilege('public', 'public.mark_payment_refunded(uuid)', 'execute') then
    raise exception 'CASO 7: public NO debía poder ejecutarla.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: el camino de refund por el webhook (T5) sigue andando con el CHECK:
-- un turno cancelado por cancel_paid_booking cierra con un aviso 'refunded'.
-- ------------------------------------------------------------
do $$
declare
  t t_ids; v_b uuid; v_p uuid; v_res text; v_apply text;
begin
  select * into t from t_ids;
  v_b := pg_temp.mk_booking('confirmed', 'paid', 15);
  v_p := pg_temp.mk_payment(v_b, 'approved', 'mp-main-5');
  v_res := pg_temp.try_as(t.owner_u, format('select public.cancel_paid_booking(%L)', v_b));
  if v_res <> 'ok' then raise exception 'CASO 8: cancel falló: %.', v_res; end if;

  set local role service_role;
  v_apply := public.apply_booking_payment(t.tenant_id, v_b, 'mp-main-5', 'refunded', 1000, 'ARS');
  reset role;
  if v_apply <> 'applied'
     or (select payment_status from public.bookings where id = v_b) <> 'refunded' then
    raise exception 'CASO 8: el aviso refunded debía cerrar el turno (dio %).', v_apply;
  end if;
end $$;

rollback;
