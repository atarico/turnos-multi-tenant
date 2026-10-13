-- ============================================================
-- Test SQL para 20261003120001_customer_payments_foundation.sql
--
-- Misma convención que `trial_expiry.sql` y `tenants_column_grants.sql`:
-- assertions con `do $$ ... raise exception ... $$`, cada bloque arma lo que
-- necesita, todo en una transacción con ROLLBACK, y los bloques de permisos
-- cambian de rol con `set local role` + el GUC que lee `auth.uid()`. Correr
-- como superusuario no probaría nada: el owner saltea RLS *y* los grants.
--
-- Dos reglas que se repiten en todo el archivo:
--
-- 1. Ninguna assertion negativa viaja sola. "El insert falló" puede ser el
--    grant o puede ser un andamio mal armado; desde afuera se ven idénticos.
--    Cada rechazo lleva un control positivo sobre la MISMA fila/tabla (otro
--    rol que SÍ puede, o otra columna que SÍ se puede escribir).
--
-- 2. Un rechazo se atrapa por su SQLSTATE y no por "cualquier error", así un
--    fixture roto no se cuenta como "el guard funcionó".
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/customer_payments_foundation.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Andamio. Dos negocios (A con todo lo necesario para reservar, B sólo para
-- probar aislamiento), un dueño y un admin de A, un dueño de B y un
-- extraño sin membresía.
--
-- Timezone UTC y disponibilidad los SIETE días, igual que `trial_expiry.sql`:
-- las franjas se calculan sobre `now()` y su día de la semana cambia según
-- cuándo corra el test.
-- ------------------------------------------------------------
create temporary table t_ids (
  tenant_a   uuid,
  tenant_b   uuid,
  owner_a    uuid,
  admin_a    uuid,
  owner_b    uuid,
  stranger   uuid,
  service_id uuid,
  staff_id   uuid,
  slug       text,
  base       timestamptz
) on commit drop;

do $$
declare
  v_a uuid; v_b uuid;
  v_owner_a uuid; v_admin_a uuid; v_owner_b uuid; v_stranger uuid;
  v_service uuid; v_staff uuid;
  v_day smallint;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'owner-a@test.com') returning id into v_owner_a;
  insert into auth.users (id, email) values (gen_random_uuid(), 'admin-a@test.com') returning id into v_admin_a;
  insert into auth.users (id, email) values (gen_random_uuid(), 'owner-b@test.com') returning id into v_owner_b;
  insert into auth.users (id, email) values (gen_random_uuid(), 'stranger@test.com') returning id into v_stranger;

  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Pagos A', 'pagos-a-test', 'basico', 'AR', 'UTC') returning id into v_a;
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Pagos B', 'pagos-b-test', 'basico', 'AR', 'UTC') returning id into v_b;

  insert into public.memberships (user_id, tenant_id, role) values
    (v_owner_a, v_a, 'owner'),
    (v_admin_a, v_a, 'admin'),
    (v_owner_b, v_b, 'owner');

  -- `create_booking()` exige una suscripción que habilite (ver
  -- `tenant_takes_bookings`); el plan que se prueba acá es `tenants.plan`.
  insert into public.subscriptions (
    tenant_id, plan, status, current_period_start, current_period_end, price_usd_cents
  ) values
    (v_a, 'basico', 'active', now() - interval '1 day', now() + interval '30 days', 0),
    (v_b, 'basico', 'active', now() - interval '1 day', now() + interval '30 days', 0);

  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_a, 'Corte', 30, 1000, 'ARS') returning id into v_service;
  insert into public.staff (tenant_id, name) values (v_a, 'Ana') returning id into v_staff;
  insert into public.staff_services (staff_id, service_id) values (v_staff, v_service);
  for v_day in 0..6 loop
    insert into public.staff_availability (staff_id, weekday, start_time, end_time)
      values (v_staff, v_day, '00:00', '23:59');
  end loop;

  insert into t_ids values (
    v_a, v_b, v_owner_a, v_admin_a, v_owner_b, v_stranger, v_service, v_staff,
    'pagos-a-test',
    date_trunc('day', now() + interval '7 days')
  );
end $$;

-- `t_ids` es del superusuario: una sesión con rol cambiado no la lee. Los
-- bloques que cambian de rol leen sus ids ANTES de cambiarlo.

-- Deja a A en un estado conocido: plan pagado, cortesía, y cuenta de MP.
-- p_account: null = sin fila, o 'connected' / 'broken'.
create or replace function pg_temp.set_state(
  p_plan public.plan_tier,
  p_account text,
  p_enabled boolean default false,
  p_courtesy public.plan_tier default null,
  p_courtesy_until timestamptz default null
) returns void language plpgsql as $$
declare
  v_a uuid;
begin
  select tenant_a into v_a from t_ids;

  update public.tenants
     set plan = p_plan,
         online_payments_enabled = p_enabled,
         plan_courtesy = p_courtesy,
         plan_courtesy_until = p_courtesy_until,
         plan_courtesy_reason = case when p_courtesy is null then null else 'test' end,
         plan_courtesy_granted_at = case when p_courtesy is null then null else now() end
   where id = v_a;

  delete from public.tenant_mp_accounts where tenant_id = v_a;
  if p_account is not null then
    insert into public.tenant_mp_accounts (
      tenant_id, mp_user_id, access_token_ciphertext, refresh_token_ciphertext,
      access_token_expires_at, status
    ) values (
      v_a, 'mp-1', 'enc-access', 'enc-refresh', now() + interval '1 hour', p_account
    );
  end if;
end $$;

-- Llama a set_online_payments como `authenticated` con el JWT de p_user y
-- devuelve 'ok' o '<sqlstate>: <mensaje>'. El rol se resetea siempre.
create or replace function pg_temp.try_set(
  p_user uuid, p_tenant uuid, p_enabled boolean
) returns text language plpgsql as $$
declare
  v_res text := 'ok';
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  set local role authenticated;
  begin
    perform public.set_online_payments(p_tenant, p_enabled);
  exception when others then
    v_res := sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  return v_res;
end $$;

create or replace function pg_temp.flag() returns boolean language sql as $$
  select online_payments_enabled from public.tenants where id = (select tenant_a from t_ids);
$$;

-- ------------------------------------------------------------
-- Caso 1: los tokens y los eventos son inalcanzables desde una sesión.
--         anon y authenticated (incluso el DUEÑO) no pueden leer, insertar
--         ni actualizar; service_role sí (control positivo).
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid;
  v_role text; v_tbl text; v_op text; v_sql text;
  v_rechazado boolean;
  v_n int;
begin
  select tenant_a, owner_a into v_a, v_owner from t_ids;

  -- Control positivo: el service role escribe y lee las dos tablas.
  set local role service_role;
  insert into public.tenant_mp_accounts (
    tenant_id, mp_user_id, access_token_ciphertext, refresh_token_ciphertext,
    access_token_expires_at
  ) values (v_a, 'mp-1', 'enc-access', 'enc-refresh', now() + interval '1 hour');
  insert into public.payment_events (provider, provider_event_id, tenant_id)
    values ('mercadopago', 'evt-ctrl', v_a);
  select count(*) into v_n from public.tenant_mp_accounts;
  reset role;
  if v_n <> 1 then
    raise exception 'CASO 1: el control positivo falló: service_role vio % cuentas.', v_n;
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_tbl in array array['tenant_mp_accounts', 'payment_events'] loop
      foreach v_op in array array['select', 'insert', 'update'] loop
        v_sql := case v_op
          when 'select' then format('select count(*) from public.%I', v_tbl)
          when 'update' then format('update public.%I set tenant_id = tenant_id', v_tbl)
          when 'insert' then case v_tbl
            when 'tenant_mp_accounts' then format($f$insert into public.tenant_mp_accounts
              (tenant_id, mp_user_id, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at)
              values (%L, 'x', 'x', 'x', now())$f$, v_a)
            else format($f$insert into public.payment_events (provider, provider_event_id, tenant_id)
              values ('mercadopago', 'evt-bad', %L)$f$, v_a)
          end
        end;

        v_rechazado := false;
        execute format('set local role %I', v_role);
        begin
          execute v_sql;
        exception when insufficient_privilege then
          v_rechazado := true;
        end;
        reset role;

        if not v_rechazado then
          raise exception 'CASO 1: % pudo hacer % sobre %.', v_role, v_op, v_tbl;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Caso 2: el dueño no puede prender el flag con un UPDATE pelado, y la marca
--         sigue editable en la misma sesión (control positivo).
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_color text;
  v_rechazado boolean := false;
begin
  select tenant_a, owner_a into v_a, v_owner from t_ids;
  perform pg_temp.set_state('pro', 'connected');

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  update public.tenants set brand_color = '#112233' where id = v_a;

  begin
    update public.tenants set online_payments_enabled = true where id = v_a;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  reset role;

  if not v_rechazado then
    raise exception 'CASO 2: el dueño PUDO escribir online_payments_enabled directo.';
  end if;
  select brand_color into v_color from public.tenants where id = v_a;
  if v_color is distinct from '#112233' then
    raise exception 'CASO 2: el control positivo falló (brand_color quedó %).', v_color;
  end if;
  if pg_temp.flag() then
    raise exception 'CASO 2: el flag quedó prendido.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: la matriz de set_online_payments().
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_admin uuid; v_stranger uuid;
  v_res text; v_plan_msg text; v_conn_msg text;
begin
  select tenant_a, owner_a, admin_a, stranger into v_a, v_owner, v_admin, v_stranger from t_ids;

  -- 3a. Un admin (miembro, no dueño) y un extraño son rechazados, aun con el
  --     plan y la cuenta en regla. Control: el dueño, mismo estado, entra.
  perform pg_temp.set_state('pro', 'connected');
  v_res := pg_temp.try_set(v_admin, v_a, true);
  if v_res not like '42501:%' then
    raise exception 'CASO 3a: un admin debía recibir 42501, recibió %.', v_res;
  end if;
  v_res := pg_temp.try_set(v_stranger, v_a, true);
  if v_res not like '42501:%' then
    raise exception 'CASO 3a: un extraño debía recibir 42501, recibió %.', v_res;
  end if;
  if pg_temp.flag() then
    raise exception 'CASO 3a: un rechazo prendió el flag igual.';
  end if;
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' or not pg_temp.flag() then
    raise exception 'CASO 3a (control): el dueño no pudo prenderlo: %.', v_res;
  end if;

  -- 3b. Basico, aunque la cuenta esté conectada: rechazado por el plan.
  perform pg_temp.set_state('basico', 'connected');
  v_plan_msg := pg_temp.try_set(v_owner, v_a, true);
  if v_plan_msg not like 'P0001:%' or pg_temp.flag() then
    raise exception 'CASO 3b: basico debía ser rechazado (P0001), dio % (flag=%).', v_plan_msg, pg_temp.flag();
  end if;

  -- 3c. Pro sin cuenta: rechazado por la conexión, con OTRO mensaje.
  perform pg_temp.set_state('pro', null);
  v_conn_msg := pg_temp.try_set(v_owner, v_a, true);
  if v_conn_msg not like 'P0001:%' or pg_temp.flag() then
    raise exception 'CASO 3c: pro sin cuenta debía ser rechazado (P0001), dio % (flag=%).', v_conn_msg, pg_temp.flag();
  end if;
  if v_conn_msg = v_plan_msg then
    raise exception 'CASO 3c: el rechazo por conexión y el de plan tienen el MISMO mensaje (%).', v_conn_msg;
  end if;

  -- 3d. Pro con cuenta rota: igual que sin cuenta.
  perform pg_temp.set_state('pro', 'broken');
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> v_conn_msg or pg_temp.flag() then
    raise exception 'CASO 3d: cuenta rota debía dar %, dio % (flag=%).', v_conn_msg, v_res, pg_temp.flag();
  end if;

  -- 3e. Pro conectado y premium conectado: permitido.
  perform pg_temp.set_state('pro', 'connected');
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' or not pg_temp.flag() then
    raise exception 'CASO 3e: pro conectado debía poder, dio % (flag=%).', v_res, pg_temp.flag();
  end if;
  perform pg_temp.set_state('premium', 'connected');
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' or not pg_temp.flag() then
    raise exception 'CASO 3e: premium conectado debía poder, dio % (flag=%).', v_res, pg_temp.flag();
  end if;

  -- 3f. Apagar siempre se puede, aun con plan basico y sin cuenta (el estado
  --     de un negocio que bajó de plan con el flag prendido). Un no-dueño no.
  perform pg_temp.set_state('basico', null, true);
  v_res := pg_temp.try_set(v_admin, v_a, false);
  if v_res not like '42501:%' or not pg_temp.flag() then
    raise exception 'CASO 3f: un admin no debía poder apagarlo, dio % (flag=%).', v_res, pg_temp.flag();
  end if;
  v_res := pg_temp.try_set(v_owner, v_a, false);
  if v_res <> 'ok' or pg_temp.flag() then
    raise exception 'CASO 3f: el dueño debía poder apagarlo siempre, dio % (flag=%).', v_res, pg_temp.flag();
  end if;

  -- 3g. Cortesía: basico + cortesía pro vigente habilita; vencida no; y una
  --     cortesía menor que lo pagado no empeora nada (premium + cortesía basico).
  perform pg_temp.set_state('basico', 'connected', false, 'pro', now() + interval '10 days');
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' or not pg_temp.flag() then
    raise exception 'CASO 3g: basico + cortesía pro vigente debía poder, dio % (flag=%).', v_res, pg_temp.flag();
  end if;

  perform pg_temp.set_state('basico', 'connected', false, 'pro', now() - interval '1 day');
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> v_plan_msg or pg_temp.flag() then
    raise exception 'CASO 3g: cortesía VENCIDA debía dar %, dio % (flag=%).', v_plan_msg, v_res, pg_temp.flag();
  end if;

  -- Cortesía SIN vencimiento ("hasta que la saquen"): habilita.
  perform pg_temp.set_state('basico', 'connected', false, 'pro', null);
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' or not pg_temp.flag() then
    raise exception 'CASO 3g: basico + cortesía pro sin vencimiento debía poder, dio % (flag=%).', v_res, pg_temp.flag();
  end if;

  perform pg_temp.set_state('premium', 'connected', false, 'basico', null);
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' then
    raise exception 'CASO 3g: una cortesía menor no debía empeorar premium, dio %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: tenant_requires_payment() para cada combinación.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid;
  c record;
  v_got boolean;
begin
  select tenant_a into v_a from t_ids;

  for c in
    select * from (values
      -- descripción,                       plan,      cuenta,      enabled, cortesía, hasta,                         esperado
      ('flag apagado, todo en regla',        'pro',     'connected', false,  null,     null::timestamptz,              false),
      ('basico (bajó de plan), flag prendido','basico', 'connected', true,   null,     null,                           false),
      ('pro sin cuenta',                     'pro',     null,        true,   null,     null,                           false),
      ('pro con cuenta rota',                'pro',     'broken',    true,   null,     null,                           false),
      ('pro conectado y prendido',           'pro',     'connected', true,   null,     null,                           true),
      ('premium conectado y prendido',       'premium', 'connected', true,   null,     null,                           true),
      ('basico + cortesía pro vigente',      'basico',  'connected', true,   'pro',    now() + interval '5 days',      true),
      ('basico + cortesía pro sin vencimiento','basico', 'connected', true,   'pro',    null,                           true),
      ('premium + cortesía basico (no empeora)','premium','connected', true,  'basico', null,                           true),
      ('basico + cortesía pro vencida',      'basico',  'connected', true,   'pro',    now() - interval '1 day',       false)
    ) as t(descr, plan, account, enabled, courtesy, until, expected)
  loop
    perform pg_temp.set_state(
      c.plan::public.plan_tier, c.account, c.enabled,
      c.courtesy::public.plan_tier, c.until
    );
    v_got := public.tenant_requires_payment(v_a);
    if v_got is distinct from c.expected then
      raise exception 'CASO 4: "%": esperaba %, dio %.', c.descr, c.expected, v_got;
    end if;
  end loop;

  -- Un negocio inexistente no exige pago.
  if public.tenant_requires_payment(gen_random_uuid()) is distinct from false then
    raise exception 'CASO 4: un negocio inexistente exigió pago.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: create_public_booking() deja un hold SÓLO cuando se exige pago;
--         create_booking() del panel nunca.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_staff uuid; v_service uuid; v_slug text; v_base timestamptz;
  b public.bookings;
begin
  select tenant_a, owner_a, staff_id, service_id, slug, base
    into v_a, v_owner, v_staff, v_service, v_slug, v_base from t_ids;

  -- 5a. Se exige pago: pending + awaiting + vence en ~15 minutos.
  perform pg_temp.set_state('pro', 'connected', true);
  set local role service_role;
  b := public.create_public_booking(
    v_slug, v_staff, v_service, v_base + interval '10 hours',
    'Cliente', 'ip-hash-1', null, '1122334455'
  );
  reset role;
  if b.status <> 'pending' or b.payment_status <> 'awaiting' then
    raise exception 'CASO 5a: esperaba pending/awaiting, dio %/%.', b.status, b.payment_status;
  end if;
  if b.payment_expires_at is null
     or b.payment_expires_at < now() + interval '14 minutes'
     or b.payment_expires_at > now() + interval '16 minutes' then
    raise exception 'CASO 5a: payment_expires_at fuera de ~15 min: %.', b.payment_expires_at;
  end if;
  -- Lo devuelto es lo guardado.
  if not exists (
    select 1 from public.bookings
     where id = b.id and status = 'pending' and payment_status = 'awaiting'
  ) then
    raise exception 'CASO 5a: la fila guardada no coincide con la devuelta.';
  end if;

  -- 5b. El mismo flujo con el flag apagado: sin cambios.
  perform pg_temp.set_state('pro', 'connected', false);
  set local role service_role;
  b := public.create_public_booking(
    v_slug, v_staff, v_service, v_base + interval '11 hours',
    'Cliente', 'ip-hash-2', null, '1122334455'
  );
  reset role;
  if b.status <> 'confirmed' or b.payment_status <> 'not_required' or b.payment_expires_at is not null then
    raise exception 'CASO 5b: sin pago debía ser confirmed/not_required/null, dio %/%/%.',
      b.status, b.payment_status, b.payment_expires_at;
  end if;

  -- 5c. Un negocio basico con el flag prendido (bajó de plan): sin pago.
  perform pg_temp.set_state('basico', 'connected', true);
  set local role service_role;
  b := public.create_public_booking(
    v_slug, v_staff, v_service, v_base + interval '12 hours',
    'Cliente', 'ip-hash-3', null, '1122334455'
  );
  reset role;
  if b.status <> 'confirmed' or b.payment_status <> 'not_required' then
    raise exception 'CASO 5c: basico debía reservar sin pago, dio %/%.', b.status, b.payment_status;
  end if;

  -- 5c2. Se exige pago pero el servicio es GRATIS (price_cents = 0): no hay
  --      nada que cobrar, así que no hay hold. Control: el mismo negocio con un
  --      servicio pago sí lo deja (5a).
  perform pg_temp.set_state('pro', 'connected', true);
  update public.services set price_cents = 0 where id = v_service;
  set local role service_role;
  b := public.create_public_booking(
    v_slug, v_staff, v_service, v_base + interval '12 hours 30 minutes',
    'Cliente', 'ip-hash-3b', null, '1122334455'
  );
  reset role;
  update public.services set price_cents = 1000 where id = v_service;
  if b.status <> 'confirmed' or b.payment_status <> 'not_required' or b.payment_expires_at is not null then
    raise exception 'CASO 5c2: un servicio gratis debía reservar sin hold, dio %/%.', b.status, b.payment_status;
  end if;

  -- 5d. El dueño carga un turno desde el panel con el pago exigido: nunca hold.
  perform pg_temp.set_state('pro', 'connected', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;
  b := public.create_booking(v_slug, v_staff, v_service, v_base + interval '13 hours', 'Mostrador');
  reset role;
  if b.status <> 'confirmed' or b.payment_status <> 'not_required' or b.payment_expires_at is not null then
    raise exception 'CASO 5d: el panel debía crear confirmed/not_required, dio %/%.', b.status, b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: la constraint — un hold sin vencimiento no existe.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_staff uuid; v_service uuid; v_base timestamptz;
  v_rechazado boolean := false;
begin
  select tenant_a, staff_id, service_id, base into v_a, v_staff, v_service, v_base from t_ids;

  -- Control positivo: el mismo insert CON vencimiento entra.
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Con vencimiento',
    v_base + interval '20 hours', v_base + interval '20 hours 30 minutes',
    'pending', 'awaiting', now() + interval '10 minutes'
  );

  begin
    insert into public.bookings (
      tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
      status, payment_status, payment_expires_at
    ) values (
      v_a, v_staff, v_service, 'Sin vencimiento',
      v_base + interval '21 hours', v_base + interval '21 hours 30 minutes',
      'pending', 'awaiting', null
    );
  exception when check_violation then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'CASO 6: un awaiting sin payment_expires_at entró.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: un hold VENCIDO libera el cupo; uno vigente lo sigue ocupando.
--         create_booking, reschedule_booking y public_booking_load.
--         Cupo 1, así que un solo turno vivo llena la franja.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_staff uuid; v_service uuid; v_slug text; v_base timestamptz;
  v_expired_slot timestamptz; v_live_slot timestamptz; v_id uuid;
  v_n int;
  v_rechazado boolean;
  b public.bookings;
begin
  select tenant_a, owner_a, staff_id, service_id, slug, base
    into v_a, v_owner, v_staff, v_service, v_slug, v_base from t_ids;
  perform pg_temp.set_state('pro', 'connected', false);

  v_expired_slot := v_base + interval '15 hours';
  v_live_slot    := v_base + interval '16 hours';

  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values
    (v_a, v_staff, v_service, 'Hold vencido', v_expired_slot, v_expired_slot + interval '30 minutes',
     'pending', 'awaiting', now() - interval '1 minute'),
    (v_a, v_staff, v_service, 'Hold vigente', v_live_slot, v_live_slot + interval '30 minutes',
     'pending', 'awaiting', now() + interval '10 minutes');

  -- 7a. public_booking_load, leída como anon: el vencido no aparece, el
  --     vigente sí (y eso prueba que anon puede leer la vista).
  set local role anon;
  select count(*) into v_n from public.public_booking_load
   where staff_id = v_staff and starts_at = v_expired_slot;
  if v_n <> 0 then
    reset role;
    raise exception 'CASO 7a: el hold vencido figura en public_booking_load.';
  end if;
  select count(*) into v_n from public.public_booking_load
   where staff_id = v_staff and starts_at = v_live_slot;
  reset role;
  if v_n <> 1 then
    raise exception 'CASO 7a: el hold vigente debía figurar (1), figura % veces.', v_n;
  end if;

  -- 7b. create_booking: el hold vigente bloquea.
  v_rechazado := false;
  begin
    perform public.create_booking(v_slug, v_staff, v_service, v_live_slot, 'Otro');
  exception when sqlstate 'P0001' then
    v_rechazado := sqlerrm ilike '%No quedan lugares%';
  end;
  if not v_rechazado then
    raise exception 'CASO 7b: un hold vigente no bloqueó la franja.';
  end if;

  -- 7c. create_booking: el hold vencido NO bloquea.
  b := public.create_booking(v_slug, v_staff, v_service, v_expired_slot, 'Otro');
  if b.status <> 'confirmed' then
    raise exception 'CASO 7c: esperaba confirmed, dio %.', b.status;
  end if;

  -- 7d. reschedule_booking: mover un turno propio a la franja del hold
  --     vencido entra; a la del vigente, no.
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status
  ) values (
    v_a, v_staff, v_service, 'A mover',
    v_base + interval '18 hours', v_base + interval '18 hours 30 minutes', 'confirmed'
  ) returning id into v_id;

  -- Otra franja con un hold vencido, distinta de la que ya ocupó 7c.
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Hold vencido 2',
    v_base + interval '19 hours', v_base + interval '19 hours 30 minutes',
    'pending', 'awaiting', now() - interval '1 second'
  );

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_rechazado := false;
  begin
    perform public.reschedule_booking(v_id, v_live_slot);
  exception when sqlstate 'P0001' then
    v_rechazado := sqlerrm ilike '%No quedan lugares%';
  end;
  if not v_rechazado then
    reset role;
    raise exception 'CASO 7d: reprogramar sobre un hold vigente no fue bloqueado.';
  end if;

  b := public.reschedule_booking(v_id, v_base + interval '19 hours');
  reset role;
  if b.starts_at <> v_base + interval '19 hours' then
    raise exception 'CASO 7d: reprogramar sobre un hold vencido no movió el turno.';
  end if;

  -- 7e. Un turno CONFIRMADO normal sigue ocupando cupo (no se rompió el
  --     filtro para el resto).
  v_rechazado := false;
  begin
    perform public.create_booking(v_slug, v_staff, v_service, v_expired_slot, 'Otro más');
  exception when sqlstate 'P0001' then
    v_rechazado := sqlerrm ilike '%No quedan lugares%';
  end;
  if not v_rechazado then
    raise exception 'CASO 7e: un turno confirmado dejó de ocupar cupo.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: un miembro NO puede escribir los campos de pago de un turno, pero
--         sigue cambiando el estado (control positivo: la agenda funciona).
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_staff uuid; v_service uuid; v_base timestamptz;
  v_id uuid;
  v_rechazado boolean;
  b public.bookings;
begin
  select tenant_a, owner_a, staff_id, service_id, base
    into v_a, v_owner, v_staff, v_service, v_base from t_ids;

  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Hold',
    v_base + interval '22 hours', v_base + interval '22 hours 30 minutes',
    'pending', 'awaiting', now() + interval '10 minutes'
  ) returning id into v_id;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  -- Control positivo: el dueño cancela (lo único que la app escribe).
  update public.bookings set notes = 'nota' where id = v_id;

  v_rechazado := false;
  begin
    update public.bookings set payment_status = 'paid' where id = v_id;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    reset role;
    raise exception 'CASO 8: el dueño PUDO escribir bookings.payment_status.';
  end if;

  v_rechazado := false;
  begin
    update public.bookings set payment_expires_at = now() + interval '1 year' where id = v_id;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    reset role;
    raise exception 'CASO 8: el dueño PUDO escribir bookings.payment_expires_at.';
  end if;

  update public.bookings set status = 'cancelled' where id = v_id;
  reset role;

  select * into b from public.bookings where id = v_id;
  if b.notes is distinct from 'nota' or b.status <> 'cancelled' then
    raise exception 'CASO 8: el control positivo falló (notes=%, status=%).', b.notes, b.status;
  end if;
  if b.payment_status <> 'awaiting' then
    raise exception 'CASO 8: payment_status cambió a %.', b.payment_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: booking_payments — un miembro ve SÓLO los de su negocio, y no
--         escribe nada; anon no lee.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_b uuid; v_owner_a uuid; v_owner_b uuid; v_staff uuid; v_service uuid; v_base timestamptz;
  v_bk_a uuid; v_bk_b uuid; v_staff_b uuid; v_service_b uuid;
  v_n int; v_other int;
  v_rechazado boolean;
  v_op text;
begin
  select tenant_a, tenant_b, owner_a, owner_b, staff_id, service_id, base
    into v_a, v_b, v_owner_a, v_owner_b, v_staff, v_service, v_base from t_ids;

  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_b, 'Corte B', 30, 1000, 'ARS') returning id into v_service_b;
  insert into public.staff (tenant_id, name) values (v_b, 'Beto') returning id into v_staff_b;

  insert into public.bookings (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at)
    values (v_a, v_staff, v_service, 'Pago A', v_base + interval '23 hours', v_base + interval '23 hours 30 minutes')
    returning id into v_bk_a;
  insert into public.bookings (tenant_id, staff_id, service_id, customer_name, starts_at, ends_at)
    values (v_b, v_staff_b, v_service_b, 'Pago B', v_base + interval '23 hours', v_base + interval '23 hours 30 minutes')
    returning id into v_bk_b;

  -- Las escribe el service role, único camino de escritura.
  set local role service_role;
  insert into public.booking_payments (
    booking_id, tenant_id, mp_preference_id, mp_payment_id, status, amount_cents, currency
  ) values
    (v_bk_a, v_a, 'pref-a', 'pay-a', 'approved', 1000, 'ARS'),
    (v_bk_b, v_b, 'pref-b', 'pay-b', 'approved', 1000, 'ARS');
  reset role;

  -- Cada dueño ve exactamente la suya.
  perform set_config('request.jwt.claim.sub', v_owner_a::text, true);
  set local role authenticated;
  select count(*) filter (where tenant_id = v_a), count(*) filter (where tenant_id <> v_a)
    into v_n, v_other from public.booking_payments;
  reset role;
  if v_n <> 1 or v_other <> 0 then
    raise exception 'CASO 9: el dueño A ve % propios y % ajenos (esperaba 1 y 0).', v_n, v_other;
  end if;

  perform set_config('request.jwt.claim.sub', v_owner_b::text, true);
  set local role authenticated;
  select count(*) filter (where tenant_id = v_b), count(*) filter (where tenant_id <> v_b)
    into v_n, v_other from public.booking_payments;
  reset role;
  if v_n <> 1 or v_other <> 0 then
    raise exception 'CASO 9: el dueño B ve % propios y % ajenos (esperaba 1 y 0).', v_n, v_other;
  end if;

  -- Un miembro no inserta, actualiza ni borra.
  perform set_config('request.jwt.claim.sub', v_owner_a::text, true);
  foreach v_op in array array['insert', 'update', 'delete'] loop
    v_rechazado := false;
    set local role authenticated;
    begin
      if v_op = 'insert' then
        insert into public.booking_payments (booking_id, tenant_id, status, amount_cents, currency)
          values (v_bk_a, v_a, 'approved', 1, 'ARS');
      elsif v_op = 'update' then
        update public.booking_payments set amount_cents = 1 where tenant_id = v_a;
      else
        delete from public.booking_payments where tenant_id = v_a;
      end if;
    exception when insufficient_privilege then
      v_rechazado := true;
    end;
    reset role;
    if not v_rechazado then
      raise exception 'CASO 9: un miembro pudo hacer % sobre booking_payments.', v_op;
    end if;
  end loop;

  -- La fila de A sigue intacta (el rechazo no fue un no-op silencioso).
  if (select amount_cents from public.booking_payments where tenant_id = v_a) <> 1000 then
    raise exception 'CASO 9: el monto de la fila de A cambió.';
  end if;

  -- anon no lee.
  v_rechazado := false;
  set local role anon;
  begin
    perform count(*) from public.booking_payments;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  reset role;
  if not v_rechazado then
    raise exception 'CASO 9: anon pudo leer booking_payments.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 10: dedup — el mismo evento no entra dos veces, uno distinto sí.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid;
  v_rechazado boolean := false;
begin
  select tenant_a into v_a from t_ids;

  insert into public.payment_events (provider, provider_event_id, tenant_id)
    values ('mercadopago', 'evt-dup', v_a);
  -- Control: otro id y otro provider con el mismo id sí entran.
  insert into public.payment_events (provider, provider_event_id, tenant_id)
    values ('mercadopago', 'evt-otro', v_a);
  insert into public.payment_events (provider, provider_event_id, tenant_id)
    values ('otro-proveedor', 'evt-dup', v_a);

  begin
    insert into public.payment_events (provider, provider_event_id, tenant_id)
      values ('mercadopago', 'evt-dup', v_a);
  exception when unique_violation then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'CASO 10: el mismo evento entró dos veces.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 11 (F1): un hold NUNCA se confirma fuera del camino de pago.
--   · el UPDATE directo a 'confirmed' de un turno 'awaiting' lo frena el CHECK
--   · reprogramar un hold (vencido o no) se rechaza con su propio mensaje
--   · cancelarlo SIGUE funcionando
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_staff uuid; v_service uuid; v_base timestamptz;
  v_live uuid; v_expired uuid; v_other uuid;
  v_rechazado boolean;
  v_msg text;
begin
  select tenant_a, owner_a, staff_id, service_id, base
    into v_a, v_owner, v_staff, v_service, v_base from t_ids;

  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Hold vigente',
    v_base + interval '1 day 8 hours', v_base + interval '1 day 8 hours 30 minutes',
    'pending', 'awaiting', now() + interval '10 minutes'
  ) returning id into v_live;
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Hold vencido',
    v_base + interval '1 day 9 hours', v_base + interval '1 day 9 hours 30 minutes',
    'pending', 'awaiting', now() - interval '1 minute'
  ) returning id into v_expired;
  -- Un turno normal, para el control positivo del reschedule.
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, starts_at, ends_at, status
  ) values (
    v_a, v_staff, v_service, 'Normal',
    v_base + interval '1 day 10 hours', v_base + interval '1 day 10 hours 30 minutes', 'confirmed'
  ) returning id into v_other;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  -- 11a. El UPDATE directo a 'confirmed' (que el grant de columna SÍ permite)
  --      lo frena el CHECK, vigente o vencido.
  v_rechazado := false;
  begin
    update public.bookings set status = 'confirmed' where id = v_live;
  exception when check_violation then
    v_rechazado := true;
  end;
  if not v_rechazado then
    reset role;
    raise exception 'CASO 11a: un awaiting vigente pasó a confirmed con un UPDATE directo.';
  end if;
  v_rechazado := false;
  begin
    update public.bookings set status = 'confirmed' where id = v_expired;
  exception when check_violation then
    v_rechazado := true;
  end;
  if not v_rechazado then
    reset role;
    raise exception 'CASO 11a: un awaiting vencido pasó a confirmed con un UPDATE directo.';
  end if;

  -- 11b. Reprogramar un hold se rechaza (P0001, mensaje propio), y el turno
  --      normal SÍ se puede reprogramar a la misma franja (control).
  perform public.reschedule_booking(v_other, v_base + interval '1 day 11 hours');

  foreach v_msg in array array[v_live::text, v_expired::text] loop
    v_rechazado := false;
    begin
      perform public.reschedule_booking(v_msg::uuid, v_base + interval '1 day 12 hours');
    exception when sqlstate 'P0001' then
      v_rechazado := sqlerrm ilike '%espera un pago%';
    end;
    if not v_rechazado then
      reset role;
      raise exception 'CASO 11b: reprogramar el hold % no se rechazó con el mensaje del pago.', v_msg;
    end if;
  end loop;

  -- 11c. Cancelar un hold sigue andando.
  update public.bookings set status = 'cancelled' where id = v_live;
  update public.bookings set status = 'cancelled' where id = v_expired;
  reset role;

  if (select count(*) from public.bookings where id in (v_live, v_expired) and status = 'cancelled') <> 2 then
    raise exception 'CASO 11c: no se pudieron cancelar los holds.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 12 (F2a): un hold sin pagar NUNCA recibe recordatorio (vencido o no).
--                Control: un turno normal de mañana sí.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_staff uuid; v_service uuid; v_tomorrow timestamptz;
  v_normal uuid; v_live uuid; v_expired uuid;
  v_ids uuid[];
begin
  select tenant_a, staff_id, service_id,
         date_trunc('day', now()) + interval '1 day'
    into v_a, v_staff, v_service, v_tomorrow from t_ids;

  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, customer_email, starts_at, ends_at, status
  ) values (
    v_a, v_staff, v_service, 'Normal', 'n@test.com',
    v_tomorrow + interval '10 hours', v_tomorrow + interval '10 hours 30 minutes', 'confirmed'
  ) returning id into v_normal;
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, customer_email, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Hold vigente', 'l@test.com',
    v_tomorrow + interval '11 hours', v_tomorrow + interval '11 hours 30 minutes',
    'pending', 'awaiting', now() + interval '10 minutes'
  ) returning id into v_live;
  insert into public.bookings (
    tenant_id, staff_id, service_id, customer_name, customer_email, starts_at, ends_at,
    status, payment_status, payment_expires_at
  ) values (
    v_a, v_staff, v_service, 'Hold vencido', 'e@test.com',
    v_tomorrow + interval '12 hours', v_tomorrow + interval '12 hours 30 minutes',
    'pending', 'awaiting', now() - interval '1 minute'
  ) returning id into v_expired;

  select array_agg(booking_id) into v_ids from public.bookings_due_for_reminder(5000);

  if not (v_normal = any (coalesce(v_ids, '{}'))) then
    raise exception 'CASO 12: el control falló: el turno normal de mañana no está en los recordatorios.';
  end if;
  if v_live = any (v_ids) or v_expired = any (v_ids) then
    raise exception 'CASO 12: un hold sin pagar recibiría recordatorio.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 13 (F2b): un hold VENCIDO no bloquea el borrado de un servicio ni de un
--                profesional; uno vigente y un turno normal sí.
--                Cada sub-caso arma su propio servicio/profesional.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_base timestamptz;
  v_svc uuid; v_stf uuid;
  v_out public.delete_outcome;
  v_kind text; v_hold text;
begin
  select tenant_a, owner_a, base into v_a, v_owner, v_base from t_ids;

  foreach v_kind in array array['service', 'staff'] loop
    foreach v_hold in array array['expired', 'live', 'confirmed'] loop
      insert into public.services (tenant_id, name, duration_min, price_cents, currency)
        values (v_a, 'Borrable', 30, 1000, 'ARS') returning id into v_svc;
      insert into public.staff (tenant_id, name) values (v_a, 'Borrable') returning id into v_stf;
      -- Para borrar el servicio el turno cuelga de OTRO profesional, y al revés:
      -- así lo único que mira cada función es la columna que le toca.
      if v_kind = 'service' then
        insert into public.bookings (
          tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
          status, payment_status, payment_expires_at
        ) select v_a, s.id, v_svc, 'X',
                 v_base + interval '2 days 8 hours', v_base + interval '2 days 8 hours 30 minutes',
                 case when v_hold = 'confirmed' then 'confirmed' else 'pending' end::public.booking_status,
                 case when v_hold = 'confirmed' then 'not_required' else 'awaiting' end::public.booking_payment_status,
                 case v_hold when 'expired' then now() - interval '1 minute'
                             when 'live' then now() + interval '10 minutes' end
          from public.staff s where s.id = (select staff_id from t_ids);
      else
        insert into public.bookings (
          tenant_id, staff_id, service_id, customer_name, starts_at, ends_at,
          status, payment_status, payment_expires_at
        ) select v_a, v_stf, s.id, 'X',
                 v_base + interval '2 days 8 hours', v_base + interval '2 days 8 hours 30 minutes',
                 case when v_hold = 'confirmed' then 'confirmed' else 'pending' end::public.booking_status,
                 case when v_hold = 'confirmed' then 'not_required' else 'awaiting' end::public.booking_payment_status,
                 case v_hold when 'expired' then now() - interval '1 minute'
                             when 'live' then now() + interval '10 minutes' end
          from public.services s where s.id = (select service_id from t_ids);
      end if;

      perform set_config('request.jwt.claim.sub', v_owner::text, true);
      set local role authenticated;
      if v_kind = 'service' then
        v_out := public.delete_service(v_a, v_svc);
      else
        v_out := public.delete_staff(v_a, v_stf);
      end if;
      reset role;

      if v_hold = 'expired' and v_out <> 'deleted' then
        raise exception 'CASO 13: un hold vencido bloqueó delete_% (%).', v_kind, v_out;
      end if;
      if v_hold <> 'expired' and v_out <> 'blocked_upcoming' then
        raise exception 'CASO 13: delete_% con un turno % debía bloquear, dio %.', v_kind, v_hold, v_out;
      end if;

      -- Limpieza del sub-caso para que el siguiente arranque limpio.
      delete from public.bookings where customer_name = 'X';
      delete from public.services where id = v_svc;
      delete from public.staff where id = v_stf;
    end loop;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Caso 14 (F3, F5): los EXECUTE y los privilegios, probados con el rol real y
--                   sin pasar por RLS.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid;
  v_role text; v_fn text; v_rechazado boolean; v_msg text;
begin
  select tenant_a, owner_a into v_a, v_owner from t_ids;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  -- Llamadas reales con `set local role`. El 42501 tiene que ser el de "permission
  -- denied for function", NO el del dueño-check de adentro (mismo SQLSTATE,
  -- otro mensaje): lo que se prueba es el grant.
  for v_role, v_fn in
    select * from (values
      ('anon',          'set_online_payments'),
      ('anon',          'tenant_requires_payment'),
      ('authenticated', 'tenant_requires_payment'),
      ('anon',          'tenant_effective_plan'),
      ('authenticated', 'tenant_effective_plan')
    ) as t(r, f)
  loop
    v_rechazado := false;
    execute format('set local role %I', v_role);
    begin
      if v_fn = 'set_online_payments' then
        perform public.set_online_payments(v_a, false);
      elsif v_fn = 'tenant_requires_payment' then
        perform public.tenant_requires_payment(v_a);
      else
        perform public.tenant_effective_plan(v_a);
      end if;
    exception when insufficient_privilege then
      v_msg := sqlerrm;
      v_rechazado := v_msg ilike 'permission denied for function%';
    end;
    reset role;
    if not v_rechazado then
      raise exception 'CASO 14: % pudo ejecutar % (o falló por otro motivo: %).', v_role, v_fn, v_msg;
    end if;
  end loop;

  -- Controles positivos: lo que SÍ se concede.
  set local role authenticated;
  perform public.set_online_payments(v_a, false);
  reset role;
  set local role service_role;
  perform public.tenant_requires_payment(v_a);
  perform public.tenant_effective_plan(v_a);
  reset role;

  -- Los mismos permisos, leídos del catálogo (independientes de RLS y del flujo).
  if has_function_privilege('anon', 'public.set_online_payments(uuid, boolean)', 'execute')
     or has_function_privilege('anon', 'public.tenant_requires_payment(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.tenant_requires_payment(uuid)', 'execute')
     or has_function_privilege('anon', 'public.tenant_effective_plan(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.tenant_effective_plan(uuid)', 'execute') then
    raise exception 'CASO 14: el catálogo dice que un rol de sesión puede ejecutar una función cerrada.';
  end if;
  if not has_function_privilege('authenticated', 'public.set_online_payments(uuid, boolean)', 'execute') then
    raise exception 'CASO 14: authenticated perdió set_online_payments.';
  end if;

  -- Privilegios de tabla: ni siquiera con RLS de por medio.
  foreach v_fn in array array['tenant_mp_accounts', 'payment_events'] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_table_privilege(v_role, 'public.' || v_fn, 'select')
         or has_table_privilege(v_role, 'public.' || v_fn, 'insert')
         or has_table_privilege(v_role, 'public.' || v_fn, 'update')
         or has_table_privilege(v_role, 'public.' || v_fn, 'delete') then
        raise exception 'CASO 14: % tiene privilegios sobre %.', v_role, v_fn;
      end if;
    end loop;
    if not has_table_privilege('service_role', 'public.' || v_fn, 'insert') then
      raise exception 'CASO 14: service_role perdió el insert sobre %.', v_fn;
    end if;
  end loop;

  -- bookings: los dos campos de pago no son escribibles, y el resto de lo
  -- que la app escribe sí (control).
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_column_privilege(v_role, 'public.bookings', 'payment_status', 'update')
       or has_column_privilege(v_role, 'public.bookings', 'payment_expires_at', 'update') then
      raise exception 'CASO 14: % puede escribir un campo de pago de bookings.', v_role;
    end if;
  end loop;
  if not has_column_privilege('authenticated', 'public.bookings', 'status', 'update') then
    raise exception 'CASO 14: authenticated perdió el UPDATE sobre bookings.status.';
  end if;

  -- booking_payments: authenticated lee (grant explícito) y no escribe.
  if not has_table_privilege('authenticated', 'public.booking_payments', 'select') then
    raise exception 'CASO 14: authenticated no tiene SELECT explícito sobre booking_payments.';
  end if;
  if has_table_privilege('authenticated', 'public.booking_payments', 'insert')
     or has_table_privilege('authenticated', 'public.booking_payments', 'update')
     or has_table_privilege('authenticated', 'public.booking_payments', 'delete')
     or has_table_privilege('anon', 'public.booking_payments', 'select') then
    raise exception 'CASO 14: privilegios de más sobre booking_payments.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 15: create_booking() es del PANEL: un logueado que no es miembro no
--          reserva (saltearía el pago); un miembro y el servidor sí.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner_a uuid; v_owner_b uuid; v_stranger uuid;
  v_staff uuid; v_service uuid; v_slug text; v_base timestamptz;
  v_user uuid; v_rechazado boolean;
  b public.bookings;
begin
  select tenant_a, owner_a, owner_b, stranger, staff_id, service_id, slug, base
    into v_a, v_owner_a, v_owner_b, v_stranger, v_staff, v_service, v_slug, v_base from t_ids;
  perform pg_temp.set_state('pro', 'connected', true);

  foreach v_user in array array[v_stranger, v_owner_b] loop
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    v_rechazado := false;
    set local role authenticated;
    begin
      perform public.create_booking(v_slug, v_staff, v_service, v_base + interval '3 days 8 hours', 'Intruso');
    exception when insufficient_privilege then
      v_rechazado := true;
    end;
    reset role;
    if not v_rechazado then
      raise exception 'CASO 15: un no-miembro (%) reservó con create_booking.', v_user;
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub', v_owner_a::text, true);
  set local role authenticated;
  b := public.create_booking(v_slug, v_staff, v_service, v_base + interval '3 days 8 hours', 'Miembro');
  reset role;
  if b.status <> 'confirmed' then
    raise exception 'CASO 15: el miembro no pudo reservar (%).', b.status;
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
  b := public.create_public_booking(
    v_slug, v_staff, v_service, v_base + interval '3 days 9 hours',
    'Cliente', 'ip-hash-15', null, '1122334455'
  );
  reset role;
  if b.payment_status <> 'awaiting' then
    raise exception 'CASO 15: el camino del servidor dejó de crear el hold (%).', b.payment_status;
  end if;
end $$;

rollback;
