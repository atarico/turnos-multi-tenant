-- ============================================================
-- Test SQL para 20261003120002_trial_grants_pro.sql
--
-- Misma convención que `customer_payments_foundation.sql`: assertions con
-- `do $$ ... raise exception ... $$`, todo en una transacción con ROLLBACK, y
-- los permisos con `set local role` + el GUC que lee `auth.uid()`.
--
-- Una prueba viva da Pro; una vencida no da nada; nunca empeora lo pagado ni
-- una cortesía mayor.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/trial_grants_pro.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

create temporary table t_ids (
  tenant_a uuid,
  owner_a  uuid
) on commit drop;

do $$
declare
  v_a uuid; v_owner uuid;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'owner-trial@test.com') returning id into v_owner;

  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Prueba A', 'prueba-a-test', 'basico', 'AR', 'UTC') returning id into v_a;
  insert into public.memberships (user_id, tenant_id, role) values (v_owner, v_a, 'owner');

  insert into public.subscriptions (
    tenant_id, plan, status, current_period_start, current_period_end,
    trial_ends_at, price_usd_cents
  ) values (
    v_a, 'basico', 'trialing', now() - interval '1 day', now() + interval '6 days',
    now() + interval '6 days', 0
  );

  insert into t_ids values (v_a, v_owner);
end $$;

-- Deja a A en un estado conocido: plan pagado, cortesía, estado de la
-- suscripción y fin de la prueba, y cuenta de MP conectada (o no).
create or replace function pg_temp.set_state(
  p_plan public.plan_tier,
  p_status public.subscription_status,
  p_trial_ends timestamptz,
  p_courtesy public.plan_tier default null,
  p_connected boolean default false,
  p_enabled boolean default false
) returns void language plpgsql as $$
declare
  v_a uuid;
begin
  select tenant_a into v_a from t_ids;

  update public.tenants
     set plan = p_plan,
         online_payments_enabled = p_enabled,
         plan_courtesy = p_courtesy,
         plan_courtesy_until = null,
         plan_courtesy_reason = case when p_courtesy is null then null else 'test' end,
         plan_courtesy_granted_at = case when p_courtesy is null then null else now() end
   where id = v_a;

  update public.subscriptions
     set status = p_status, trial_ends_at = p_trial_ends
   where tenant_id = v_a;

  delete from public.tenant_mp_accounts where tenant_id = v_a;
  if p_connected then
    insert into public.tenant_mp_accounts (
      tenant_id, mp_user_id, access_token_ciphertext, refresh_token_ciphertext,
      access_token_expires_at, status
    ) values (
      v_a, 'mp-1', 'enc-access', 'enc-refresh', now() + interval '1 hour', 'connected'
    );
  end if;
end $$;

-- `tenant_effective_plan` es service_role only: se llama con ese rol.
create or replace function pg_temp.eff(p_tenant uuid) returns public.plan_tier
language plpgsql as $$
declare v public.plan_tier;
begin
  set local role service_role;
  v := public.tenant_effective_plan(p_tenant);
  reset role;
  return v;
end $$;

create or replace function pg_temp.requires(p_tenant uuid) returns boolean
language plpgsql as $$
declare v boolean;
begin
  set local role service_role;
  v := public.tenant_requires_payment(p_tenant);
  reset role;
  return v;
end $$;

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

-- ------------------------------------------------------------
-- Caso 1: plan efectivo con y sin prueba.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_got public.plan_tier;
begin
  select tenant_a into v_a from t_ids;

  perform pg_temp.set_state('basico', 'trialing', now() + interval '3 days');
  v_got := pg_temp.eff(v_a);
  if v_got <> 'pro' then
    raise exception 'CASO 1a: una prueba viva sobre basico debía dar pro y dio %.', v_got;
  end if;

  -- `tenants.plan` no se muta: es lo que se paga.
  if (select plan from public.tenants where id = v_a) <> 'basico' then
    raise exception 'CASO 1a: la prueba no debe tocar tenants.plan.';
  end if;

  perform pg_temp.set_state('basico', 'trialing', now() - interval '1 minute');
  v_got := pg_temp.eff(v_a);
  if v_got <> 'basico' then
    raise exception 'CASO 1b: una prueba vencida debía dar el plan pagado y dio %.', v_got;
  end if;

  -- Una suscripción activa con fecha de prueba futura no es una prueba.
  perform pg_temp.set_state('basico', 'active', now() + interval '3 days');
  v_got := pg_temp.eff(v_a);
  if v_got <> 'basico' then
    raise exception 'CASO 1c: una suscripción activa no es una prueba y dio %.', v_got;
  end if;

  -- Nunca empeora: premium pagado y cortesía premium durante la prueba.
  perform pg_temp.set_state('premium', 'trialing', now() + interval '3 days');
  v_got := pg_temp.eff(v_a);
  if v_got <> 'premium' then
    raise exception 'CASO 1d: la prueba empeoró un plan premium pagado: %.', v_got;
  end if;

  perform pg_temp.set_state('basico', 'trialing', now() + interval '3 days', 'premium');
  v_got := pg_temp.eff(v_a);
  if v_got <> 'premium' then
    raise exception 'CASO 1e: una cortesía premium durante la prueba debía dar premium y dio %.', v_got;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: prender los cobros durante la prueba.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_owner uuid; v_res text;
begin
  select tenant_a, owner_a into v_a, v_owner from t_ids;

  -- Prueba viva, sin cuenta conectada: pasa el chequeo de plan y falla por
  -- la cuenta (control: el motivo es "no conectado", no el plan).
  perform pg_temp.set_state('basico', 'trialing', now() + interval '3 days');
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res not like 'P0001:%conectado%' then
    raise exception 'CASO 2a: sin cuenta debía fallar por la conexión, dio %.', v_res;
  end if;

  perform pg_temp.set_state('basico', 'trialing', now() + interval '3 days', null, true);
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res <> 'ok' then
    raise exception 'CASO 2b: el dueño en prueba, conectado, debía poder prender: %.', v_res;
  end if;
  if not (select online_payments_enabled from public.tenants where id = v_a) then
    raise exception 'CASO 2b: el flag no quedó prendido.';
  end if;

  -- Control negativo: vencida la prueba, el mismo dueño ya no puede.
  perform pg_temp.set_state('basico', 'trialing', now() - interval '1 minute', null, true);
  v_res := pg_temp.try_set(v_owner, v_a, true);
  if v_res not like 'P0001:%Pro%' then
    raise exception 'CASO 2c: vencida la prueba debía exigir Pro, dio %.', v_res;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: tenant_requires_payment durante y después de la prueba.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid;
begin
  select tenant_a into v_a from t_ids;

  perform pg_temp.set_state('basico', 'trialing', now() + interval '3 days', null, true, true);
  if pg_temp.requires(v_a) is distinct from true then
    raise exception 'CASO 3a: conectado, prendido y en prueba viva debía exigir pago.';
  end if;

  perform pg_temp.set_state('basico', 'trialing', now() - interval '1 minute', null, true, true);
  if pg_temp.requires(v_a) is distinct from false then
    raise exception 'CASO 3b: vencida la prueba no debía exigir pago.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: los grants no se aflojaron al redefinir la función.
-- ------------------------------------------------------------
do $$
declare
  v_a uuid; v_role text; v_rechazado boolean;
begin
  select tenant_a into v_a from t_ids;

  foreach v_role in array array['anon', 'authenticated'] loop
    v_rechazado := false;
    execute format('set local role %I', v_role);
    begin
      perform public.tenant_effective_plan(v_a);
    exception when insufficient_privilege then
      v_rechazado := true;
    end;
    reset role;
    if not v_rechazado then
      raise exception 'CASO 4: % pudo llamar tenant_effective_plan.', v_role;
    end if;
  end loop;

  -- Control positivo: service_role sí.
  if pg_temp.eff(v_a) is null then
    raise exception 'CASO 4: el control positivo falló: service_role no obtuvo plan.';
  end if;
end $$;

rollback;
