-- ============================================================
-- Test SQL para 20261004120002_apply_booking_payment.sql
--
-- Misma convención que `payment_hold_resolution.sql`: assertions con
-- `do $$ ... raise exception ... $$`, todo en una transacción con ROLLBACK, y
-- los bloques de permisos cambian de rol con `set local role` (correr como
-- superusuario no probaría nada: el owner saltea los grants).
--
-- No hace falta sembrar `auth.users`: la función no mira sesiones ni
-- memberships, sólo turnos y pagos.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/apply_booking_payment.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

create temporary table t_ids (
  tenant_id  uuid,
  other_id   uuid,
  service_id uuid,
  staff_id   uuid,
  base       timestamptz
) on commit drop;

do $$
declare
  v_tenant uuid; v_other uuid; v_service uuid; v_staff uuid;
begin
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Pagos', 'apply-pay-test', 'pro', 'AR', 'UTC') returning id into v_tenant;
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Otro', 'apply-pay-other', 'pro', 'AR', 'UTC') returning id into v_other;
  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_tenant, 'Corte', 30, 1000, 'ARS') returning id into v_service;
  insert into public.staff (tenant_id, name) values (v_tenant, 'Ana') returning id into v_staff;
  insert into public.staff_services (staff_id, service_id) values (v_staff, v_service);

  insert into t_ids values (
    v_tenant, v_other, v_service, v_staff, date_trunc('day', now() + interval '7 days')
  );
end $$;

-- Turno directo (como superusuario) en el estado que pide el caso; precio 1000 ARS.
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

-- Llama a la función como service_role y devuelve el texto.
create or replace function pg_temp.apply(
  p_booking uuid, p_payment text, p_status text,
  p_amount int default 1000, p_currency text default 'ARS',
  p_tenant uuid default null,
  p_approved_at timestamptz default null
) returns text language plpgsql as $$
declare
  v_res text; t t_ids;
begin
  select * into t from t_ids;
  set local role service_role;
  v_res := public.apply_booking_payment(
    coalesce(p_tenant, t.tenant_id), p_booking, p_payment, p_status, p_amount, p_currency,
    p_approved_at
  );
  reset role;
  return v_res;
end $$;

-- ------------------------------------------------------------
-- Caso 1: approved + monto/moneda coinciden + hold vigente → confirmed / paid.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; p public.booking_payments;
begin
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 1);
  v_res := pg_temp.apply(v_id, 'mp-1', 'approved');
  if v_res <> 'applied' then
    raise exception 'CASO 1: esperaba applied, dio %.', v_res;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.status <> 'confirmed' or b.payment_status <> 'paid' then
    raise exception 'CASO 1: esperaba confirmed/paid, dio %/%.', b.status, b.payment_status;
  end if;
  select * into p from public.booking_payments where mp_payment_id = 'mp-1';
  if p.booking_id <> v_id or p.status <> 'approved' or p.amount_cents <> 1000 or p.currency <> 'ARS' then
    raise exception 'CASO 1: booking_payments mal registrado (%/%/%).', p.booking_id, p.status, p.amount_cents;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: el mismo aviso otra vez → duplicate y no toca nada.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; v_n int;
begin
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 2);
  if pg_temp.apply(v_id, 'mp-2', 'approved') <> 'applied' then
    raise exception 'CASO 2: la primera debía aplicarse.';
  end if;
  v_res := pg_temp.apply(v_id, 'mp-2', 'approved');
  if v_res <> 'duplicate' then
    raise exception 'CASO 2: el reintento debía ser duplicate, dio %.', v_res;
  end if;
  select count(*) into v_n from public.booking_payments where mp_payment_id = 'mp-2';
  if v_n <> 1 then
    raise exception 'CASO 2: esperaba 1 fila de pago, hay %.', v_n;
  end if;
  select count(*) into v_n from public.payment_events where provider_event_id = 'mp-2:approved';
  if v_n <> 1 then
    raise exception 'CASO 2: esperaba 1 evento, hay %.', v_n;
  end if;
  select * into b from public.bookings where id = v_id;
  if b.payment_status <> 'paid' then
    raise exception 'CASO 2: el duplicado cambió el turno (%).', b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: approved sobre un hold que ya no sirve → refund_due, turno cancelado.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings;
begin
  -- 3a. Hold cancelado (queda 'awaiting', ver cancel_payment_hold).
  v_id := pg_temp.mk_booking('cancelled', 'awaiting', now() + interval '10 minutes', 3);
  v_res := pg_temp.apply(v_id, 'mp-3a', 'approved');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 3a: esperaba applied + cancelled/refund_due, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;

  -- 3b. Hold vencido pero todavía 'pending': se cancela y se marca a devolver.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '1 minute', 4);
  v_res := pg_temp.apply(v_id, 'mp-3b', 'approved');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 3b: esperaba applied + cancelled/refund_due, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: monto o moneda distintos → refund_due y turno cancelado (nunca se
--         confirma contra lo que valía).
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings;
begin
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 5);
  v_res := pg_temp.apply(v_id, 'mp-4a', 'approved', 999);
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 4a: monto distinto, esperaba cancelled/refund_due, dio %/%.',
      b.status, b.payment_status;
  end if;

  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 6);
  v_res := pg_temp.apply(v_id, 'mp-4b', 'approved', 1000, 'USD');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 4b: moneda distinta, esperaba cancelled/refund_due, dio %/%.',
      b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: rejected / cancelled → sólo booking_payments; el hold queda intacto
--         para que el cliente reintente dentro de la ventana.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; p public.booking_payments; v_st text;
begin
  foreach v_st in array array['rejected', 'cancelled'] loop
    v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes',
                               case v_st when 'rejected' then 7 else 8 end);
    v_res := pg_temp.apply(v_id, 'mp-5-' || v_st, v_st);
    select * into b from public.bookings where id = v_id;
    if v_res <> 'applied' or b.status <> 'pending' or b.payment_status <> 'awaiting' then
      raise exception 'CASO 5 (%): el hold debía quedar intacto, dio % + %/%.',
        v_st, v_res, b.status, b.payment_status;
    end if;
    select * into p from public.booking_payments where mp_payment_id = 'mp-5-' || v_st;
    if p.status <> v_st then
      raise exception 'CASO 5 (%): booking_payments.status = %.', v_st, p.status;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Caso 6: refunded / charged_back sobre un turno pagado → refunded.
--         Sobre uno que no está pagado → ignored y sin cambios.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; v_st text; v_i int := 9;
begin
  foreach v_st in array array['refunded', 'charged_back'] loop
    v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', v_i);
    v_i := v_i + 1;
    if pg_temp.apply(v_id, 'mp-6-' || v_st, 'approved') <> 'applied' then
      raise exception 'CASO 6 (%): el cobro debía aplicarse.', v_st;
    end if;
    v_res := pg_temp.apply(v_id, 'mp-6-' || v_st, v_st);
    select * into b from public.bookings where id = v_id;
    if v_res <> 'applied' or b.payment_status <> 'refunded' then
      raise exception 'CASO 6 (%): esperaba applied + refunded, dio % + %.',
        v_st, v_res, b.payment_status;
    end if;
  end loop;

  -- Un hold que nunca se pagó no se "devuelve".
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', v_i);
  v_res := pg_temp.apply(v_id, 'mp-6-nopaid', 'refunded');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'ignored' or b.payment_status <> 'awaiting' then
    raise exception 'CASO 6: refunded sobre un no pagado debía ignorarse, dio % + %.',
      v_res, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6b: refunded / charged_back sobre un turno 'refund_due' → refunded.
--          Es el camino principal de la devolución manual: el dueño devuelve
--          desde Mercado Pago y el aviso cierra el "a devolver".
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; v_st text; v_i int := 40;
begin
  foreach v_st in array array['refunded', 'charged_back'] loop
    -- Un hold cancelado que cobró tarde: queda refund_due.
    v_id := pg_temp.mk_booking('cancelled', 'awaiting', now() + interval '10 minutes', v_i);
    v_i := v_i + 1;
    if pg_temp.apply(v_id, 'mp-6b-' || v_st, 'approved') <> 'applied' then
      raise exception 'CASO 6b (%): el cobro tardío debía aplicarse.', v_st;
    end if;
    select * into b from public.bookings where id = v_id;
    if b.payment_status <> 'refund_due' then
      raise exception 'CASO 6b (%): esperaba refund_due antes de la devolución, dio %.', v_st, b.payment_status;
    end if;

    v_res := pg_temp.apply(v_id, 'mp-6b-' || v_st, v_st);
    select * into b from public.bookings where id = v_id;
    if v_res <> 'applied' or b.payment_status <> 'refunded' or b.status <> 'cancelled' then
      raise exception 'CASO 6b (%): esperaba applied + cancelled/refunded, dio % + %/%.',
        v_st, v_res, b.status, b.payment_status;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Caso 6c: cobro doble. Un turno ya pagado recibe OTRO pago aprobado (distinto
--          mp_payment_id): el turno sigue pagado, y el pago extra queda
--          marcado 'refund_due' en booking_payments para que el dueño lo
--          devuelva.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; b public.bookings; p public.booking_payments; v_n int;
begin
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 45);
  if pg_temp.apply(v_id, 'mp-6c-first', 'approved') <> 'applied' then
    raise exception 'CASO 6c: el primer cobro debía aplicarse.';
  end if;

  v_res := pg_temp.apply(v_id, 'mp-6c-second', 'approved');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'confirmed' or b.payment_status <> 'paid' then
    raise exception 'CASO 6c: el turno debía seguir confirmed/paid, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;

  select * into p from public.booking_payments where mp_payment_id = 'mp-6c-second';
  if p.booking_id <> v_id or p.status <> 'refund_due' then
    raise exception 'CASO 6c: el pago extra debía quedar refund_due, dio %.', p.status;
  end if;

  select * into p from public.booking_payments where mp_payment_id = 'mp-6c-first';
  if p.status <> 'approved' then
    raise exception 'CASO 6c: el primer pago no debía cambiar, dio %.', p.status;
  end if;

  -- Reintento del aviso del pago extra: duplicate, sin tocar nada.
  if pg_temp.apply(v_id, 'mp-6c-second', 'approved') <> 'duplicate' then
    raise exception 'CASO 6c: el reintento del cobro extra debía ser duplicate.';
  end if;
  select count(*) into v_n from public.booking_payments where booking_id = v_id;
  if v_n <> 2 then
    raise exception 'CASO 6c: esperaba 2 filas de pago, hay %.', v_n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6d: pagó a tiempo pero se procesa tarde (el hold ya venció).
--   - A tiempo + hay lugar  -> confirmed / paid.
--   - A tiempo + sin lugar  -> refund_due, cancelado (la franja se ocupó).
--   - Aprobado DESPUÉS del vencimiento -> refund_due, cancelado.
--   - A tiempo pero el turno ya estaba cancelado -> refund_due.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_other uuid; v_res text; b public.bookings;
begin
  -- 6d-1: a tiempo, hay lugar.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '1 minute', 50);
  v_res := pg_temp.apply(v_id, 'mp-6d-1', 'approved', 1000, 'ARS', null, now() - interval '2 minutes');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'confirmed' or b.payment_status <> 'paid' then
    raise exception 'CASO 6d-1: a tiempo y con lugar, esperaba confirmed/paid, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;

  -- 6d-2: a tiempo, pero otro cliente ya tomó la franja.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '1 minute', 51);
  v_other := pg_temp.mk_booking('confirmed', 'not_required', null, 51);
  v_res := pg_temp.apply(v_id, 'mp-6d-2', 'approved', 1000, 'ARS', null, now() - interval '2 minutes');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 6d-2: sin lugar, esperaba cancelled/refund_due, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;
  select * into b from public.bookings where id = v_other;
  if b.status <> 'confirmed' then
    raise exception 'CASO 6d-2: el turno del otro cliente cambió (%).', b.status;
  end if;

  -- 6d-3: aprobado después del vencimiento.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() - interval '5 minutes', 52);
  v_res := pg_temp.apply(v_id, 'mp-6d-3', 'approved', 1000, 'ARS', null, now() - interval '1 minute');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 6d-3: tarde, esperaba cancelled/refund_due, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;

  -- 6d-4: a tiempo pero el hold ya estaba cancelado.
  v_id := pg_temp.mk_booking('cancelled', 'awaiting', now() - interval '1 minute', 53);
  v_res := pg_temp.apply(v_id, 'mp-6d-4', 'approved', 1000, 'ARS', null, now() - interval '2 minutes');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'cancelled' or b.payment_status <> 'refund_due' then
    raise exception 'CASO 6d-4: cancelado, esperaba cancelled/refund_due, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;

  -- 6d-5: hold vigente y aprobado antes del vencimiento: confirma sin re-chequear.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 54);
  v_res := pg_temp.apply(v_id, 'mp-6d-5', 'approved', 1000, 'ARS', null, now() - interval '1 minute');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'confirmed' or b.payment_status <> 'paid' then
    raise exception 'CASO 6d-5: vigente, esperaba confirmed/paid, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: se vincula la fila de la preferencia en vez de duplicar.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; t t_ids; v_n int; p public.booking_payments;
begin
  select * into t from t_ids;
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 20);
  insert into public.booking_payments (booking_id, tenant_id, mp_preference_id, status, amount_cents, currency)
    values (v_id, t.tenant_id, 'pref-7', 'pending', 1000, 'ARS');

  if pg_temp.apply(v_id, 'mp-7', 'approved') <> 'applied' then
    raise exception 'CASO 7: debía aplicarse.';
  end if;
  select count(*) into v_n from public.booking_payments where booking_id = v_id;
  if v_n <> 1 then
    raise exception 'CASO 7: esperaba 1 fila de pago (la de la preferencia), hay %.', v_n;
  end if;
  select * into p from public.booking_payments where booking_id = v_id;
  if p.mp_preference_id <> 'pref-7' or p.mp_payment_id <> 'mp-7' or p.status <> 'approved' then
    raise exception 'CASO 7: la fila no quedó vinculada (%/%/%).', p.mp_preference_id, p.mp_payment_id, p.status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: ignored — otro negocio, turno inexistente, turno que no espera pago.
-- ------------------------------------------------------------
do $$
declare
  v_id uuid; v_res text; t t_ids; b public.bookings; v_n int;
begin
  select * into t from t_ids;

  -- 8a. El turno es de OTRO negocio: no se toca y no se reclama el evento.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 21);
  v_res := pg_temp.apply(v_id, 'mp-8a', 'approved', 1000, 'ARS', t.other_id);
  select * into b from public.bookings where id = v_id;
  if v_res <> 'ignored' or b.payment_status <> 'awaiting' then
    raise exception 'CASO 8a: un negocio ajeno debía ignorarse, dio % + %.', v_res, b.payment_status;
  end if;
  select count(*) into v_n from public.payment_events where provider_event_id = 'mp-8a:approved';
  if v_n <> 0 then
    raise exception 'CASO 8a: se reclamó un evento de un negocio ajeno.';
  end if;

  -- 8b. Turno inexistente.
  v_res := pg_temp.apply(gen_random_uuid(), 'mp-8b', 'approved');
  if v_res <> 'ignored' then
    raise exception 'CASO 8b: un turno inexistente debía ignorarse, dio %.', v_res;
  end if;

  -- 8c. Un turno que no esperaba pago (p. ej. confirmado sin pago con la
  -- cuenta caída) y aun así cobra: no se puede dar en el flujo normal —sin
  -- link no hay dónde pagar—, pero si pasa es plata no esperada. El turno no
  -- cambia y ESE pago queda 'refund_due' para que el dueño lo vea.
  v_id := pg_temp.mk_booking('confirmed', 'not_required', null, 22);
  v_res := pg_temp.apply(v_id, 'mp-8c', 'approved');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'applied' or b.status <> 'confirmed' or b.payment_status <> 'not_required' then
    raise exception 'CASO 8c: esperaba applied con el turno intacto, dio % + %/%.',
      v_res, b.status, b.payment_status;
  end if;
  if not exists (
    select 1 from public.booking_payments
     where mp_payment_id = 'mp-8c' and booking_id = v_id and status = 'refund_due'
  ) then
    raise exception 'CASO 8c: el pago no esperado debía quedar refund_due.';
  end if;

  -- 8d. Estados que no mueven nada (pending / in_process): ignored, pero queda el rastro.
  v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 23);
  v_res := pg_temp.apply(v_id, 'mp-8d', 'in_process');
  select * into b from public.bookings where id = v_id;
  if v_res <> 'ignored' or b.payment_status <> 'awaiting' then
    raise exception 'CASO 8d: in_process debía ignorarse, dio % + %.', v_res, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: sólo service_role la ejecuta. Control positivo: los casos de arriba.
-- ------------------------------------------------------------
do $$
declare
  v_role text; v_id uuid; t t_ids; v_res text := 'ok'; b public.bookings;
begin
  select * into t from t_ids;
  foreach v_role in array array['anon', 'authenticated'] loop
    v_id := pg_temp.mk_booking('pending', 'awaiting', now() + interval '10 minutes', 24);
    execute format('set local role %I', v_role);
    begin
      perform public.apply_booking_payment(
        t.tenant_id, v_id, 'mp-9-' || v_role, 'approved', 1000, 'ARS', now()
      );
    exception when others then
      v_res := sqlstate || ': ' || sqlerrm;
    end;
    reset role;
    if v_res not like '42501:%permission denied for function%' then
      raise exception 'CASO 9: % ejecutó la función (%).', v_role, v_res;
    end if;
    select * into b from public.bookings where id = v_id;
    if b.status <> 'pending' or b.payment_status <> 'awaiting' then
      raise exception 'CASO 9: % tocó la fila.', v_role;
    end if;
    delete from public.bookings where id = v_id;
    v_res := 'ok';

    -- El helper de cupo tampoco queda abierto: toma un lock por profesional.
    execute format('set local role %I', v_role);
    begin
      perform public.booking_slot_has_room(gen_random_uuid());
    exception when others then
      v_res := sqlstate || ': ' || sqlerrm;
    end;
    reset role;
    if v_res not like '42501:%permission denied for function%' then
      raise exception 'CASO 9: % ejecutó booking_slot_has_room (%).', v_role, v_res;
    end if;
    v_res := 'ok';
  end loop;
end $$;

rollback;
