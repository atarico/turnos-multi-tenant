-- ============================================================
-- Test SQL para 20260830120002_plan_courtesy.sql
--
-- Misma convención que platform_admins.sql y tenants_column_grants.sql:
-- assertions con `do $$ ... raise exception ... $$`, cada bloque arma sus
-- propios datos, todo en una transacción con ROLLBACK, y los bloques cambian
-- de rol a `authenticated` seteando el GUC que lee `auth.uid()`.
--
-- Correr como superusuario no probaría nada de lo importante: saltea RLS, los
-- grants Y el `is_super_admin()` de adentro de las funciones.
--
-- Ninguna assertion negativa viaja sola: cada rechazo lleva al lado la prueba
-- de que el mismo actor SÍ puede hacer la operación legítima, para que
-- "falló" no se confunda con "el fixture estaba mal".
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/plan_courtesy.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: un super admin otorga, y queda anotado quién y por qué.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_tenant uuid;
  v_row    public.tenants;
begin
  insert into auth.users (email) values ('cort-admin@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('cort-uno', 'Negocio Uno', 'AR') returning id into v_tenant;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  perform public.grant_plan_courtesy(
    v_tenant, 'premium', '  beta tester  ', now() + interval '3 months'
  );

  reset role;

  select * into v_row from public.tenants where id = v_tenant;

  if v_row.plan_courtesy <> 'premium' then
    raise exception 'CASO 1: la cortesía quedó en % .', v_row.plan_courtesy;
  end if;
  if v_row.plan_courtesy_granted_by is distinct from v_admin then
    raise exception 'CASO 1: no quedó anotado quién la otorgó.';
  end if;
  -- El motivo se guarda recortado: los espacios de los costados son ruido de
  -- tipeo y hacen que dos motivos iguales se vean distintos.
  if v_row.plan_courtesy_reason <> 'beta tester' then
    raise exception 'CASO 1: el motivo quedó como "%" (esperaba recortado).', v_row.plan_courtesy_reason;
  end if;
  if v_row.plan_courtesy_granted_at is null then
    raise exception 'CASO 1: no quedó la fecha de otorgamiento.';
  end if;
  -- El plan PAGADO no se toca: es del webhook.
  if v_row.plan <> 'basico' then
    raise exception 'CASO 1: la cortesía pisó tenants.plan (quedó %). Eso lo borra la próxima renovación.', v_row.plan;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: un dueño común NO puede regalarse una cortesía,
--         ni llamando a la función a mano.
--
--         La función es `security definer`: corre con los
--         privilegios del dueño de la función. Lo único que
--         frena a un usuario cualquiera es el is_super_admin()
--         de adentro.
-- ------------------------------------------------------------
do $$
declare
  v_user      uuid;
  v_tenant    uuid;
  v_courtesy  public.plan_tier;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('cort-dueno@test.com') returning id into v_user;
  insert into public.tenants (slug, name, country)
    values ('cort-dos', 'Negocio Dos', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner');

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  begin
    perform public.grant_plan_courtesy(v_tenant, 'premium', 'me lo merezco');
  exception when insufficient_privilege then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 2: un dueño común se otorgó una cortesía a sí mismo.';
  end if;

  select plan_courtesy into v_courtesy from public.tenants where id = v_tenant;
  if v_courtesy is not null then
    raise exception 'CASO 2: quedó una cortesía escrita (%).', v_courtesy;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: las columnas nuevas nacen CERRADAS al update directo.
--
--         Es la propiedad que compró 20260830120001: el revoke
--         devolvió el update sólo sobre (brand_color, logo_url),
--         así que toda columna agregada después es inescribible
--         desde una sesión sin tocar otra migración. Si esto
--         falla, la cortesía se puede otorgar por PATCH y el
--         registro de quién y por qué es decorativo.
-- ------------------------------------------------------------
do $$
declare
  v_admin     uuid;
  v_tenant    uuid;
  v_color     text;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('cort-patch@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('cort-tres', 'Negocio Tres', 'AR') returning id into v_tenant;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  -- Control positivo: el operador alcanza la fila, así que el rechazo de abajo
  -- es por columna y no por aislamiento.
  update public.tenants set brand_color = '#111111' where id = v_tenant;

  begin
    update public.tenants set plan_courtesy = 'premium' where id = v_tenant;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 3: se pudo escribir plan_courtesy con un update pelado. El registro de auditoría no vale nada.';
  end if;

  select brand_color into v_color from public.tenants where id = v_tenant;
  if v_color is distinct from '#111111' then
    raise exception 'CASO 3: el control positivo falló; el rechazo no prueba nada.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: sin motivo no hay cortesía.
--         Y un motivo de puros espacios es lo mismo que ninguno.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_tenant uuid;
  v_sin    boolean := false;
  v_blanco boolean := false;
  v_row    public.tenants;
begin
  insert into auth.users (email) values ('cort-motivo@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('cort-cuatro', 'Negocio Cuatro', 'AR') returning id into v_tenant;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  begin
    perform public.grant_plan_courtesy(v_tenant, 'pro', null);
  exception when check_violation then
    v_sin := true;
  end;

  begin
    perform public.grant_plan_courtesy(v_tenant, 'pro', '   ');
  exception when check_violation then
    v_blanco := true;
  end;

  -- Control positivo: el MISMO actor sobre el MISMO negocio, con motivo, sí puede.
  perform public.grant_plan_courtesy(v_tenant, 'pro', 'trato cerrado por afuera');

  reset role;

  if not v_sin then
    raise exception 'CASO 4: se otorgó una cortesía sin motivo.';
  end if;
  if not v_blanco then
    raise exception 'CASO 4: se otorgó una cortesía con un motivo de puros espacios.';
  end if;

  select * into v_row from public.tenants where id = v_tenant;
  if v_row.plan_courtesy_reason <> 'trato cerrado por afuera' then
    raise exception 'CASO 4: el control positivo falló; los rechazos no prueban nada.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: un vencimiento ya pasado se rechaza.
--
--         Crearía una cortesía muerta al nacer: la fila diría
--         que hay un regalo y effectivePlan lo ignoraría. Un
--         estado que se ve de una forma y se comporta de otra
--         es peor que un error.
-- ------------------------------------------------------------
do $$
declare
  v_admin     uuid;
  v_tenant    uuid;
  v_courtesy  public.plan_tier;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('cort-vencida@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('cort-cinco', 'Negocio Cinco', 'AR') returning id into v_tenant;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  begin
    perform public.grant_plan_courtesy(
      v_tenant, 'premium', 'compensacion', now() - interval '1 day'
    );
  exception when check_violation then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 5: se otorgó una cortesía que ya nació vencida.';
  end if;

  select plan_courtesy into v_courtesy from public.tenants where id = v_tenant;
  if v_courtesy is not null then
    raise exception 'CASO 5: quedó escrita igual.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: quitar la cortesía la limpia ENTERA.
--
--         El CHECK exige el hecho completo o nada: si el revoke
--         dejara una sola columna colgada, la fila entera sería
--         rechazada y el negocio quedaría intocable.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_tenant uuid;
  v_row    public.tenants;
begin
  insert into auth.users (email) values ('cort-quitar@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('cort-seis', 'Negocio Seis', 'AR') returning id into v_tenant;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  perform public.grant_plan_courtesy(v_tenant, 'premium', 'prueba');
  perform public.revoke_plan_courtesy(v_tenant);

  reset role;

  select * into v_row from public.tenants where id = v_tenant;

  if v_row.plan_courtesy is not null
     or v_row.plan_courtesy_until is not null
     or v_row.plan_courtesy_reason is not null
     or v_row.plan_courtesy_granted_by is not null
     or v_row.plan_courtesy_granted_at is not null then
    raise exception 'CASO 6: quedó una columna de cortesía sin limpiar.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: un dueño común tampoco puede QUITAR una cortesía.
--         Se prueba aparte del caso 2 porque son dos funciones
--         distintas y cada una tiene su propio chequeo: copiar
--         una y olvidarse del `if` en la otra es el error real.
-- ------------------------------------------------------------
do $$
declare
  v_admin     uuid;
  v_user      uuid;
  v_tenant    uuid;
  v_courtesy  public.plan_tier;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('cort-adm2@test.com') returning id into v_admin;
  insert into auth.users (email) values ('cort-usr2@test.com') returning id into v_user;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('cort-siete', 'Negocio Siete', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.grant_plan_courtesy(v_tenant, 'premium', 'regalo vigente');
  reset role;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;
  begin
    perform public.revoke_plan_courtesy(v_tenant);
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  reset role;

  if not v_rechazado then
    raise exception 'CASO 7: un dueño común quitó una cortesía.';
  end if;

  select plan_courtesy into v_courtesy from public.tenants where id = v_tenant;
  if v_courtesy is distinct from 'premium' then
    raise exception 'CASO 7: la cortesía desapareció igual (quedó %).', v_courtesy;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: NO REGRESIÓN. El webhook sigue moviendo el plan
--         pagado, y NO toca la cortesía.
--
--         Es el escenario que motivó todo: una renovación llega
--         un mes después del regalo. Si la pisara, la cortesía
--         habría durado hasta la primera renovación, que es
--         exactamente el problema que esta migración evita.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_tenant uuid;
  v_sub    uuid;
  v_result text;
  v_row    public.tenants;
begin
  insert into auth.users (email) values ('cort-webhook@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country, plan)
    values ('cort-ocho', 'Negocio Ocho', 'AR', 'basico') returning id into v_tenant;

  insert into public.subscriptions (
    tenant_id, plan, status, current_period_end, price_usd_cents
  )
  values (v_tenant, 'basico', 'active', now() + interval '1 month', 1000)
  returning id into v_sub;

  insert into public.subscription_provider_refs (
    provider, provider_subscription_id, subscription_id, tenant_id, plan
  )
  values ('mercadopago', 'pre-cort', v_sub, v_tenant, 'pro');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.grant_plan_courtesy(v_tenant, 'premium', 'compensacion por caida');
  reset role;

  set local role service_role;
  select public.apply_subscription_payment(
    'mercadopago', 'evt-cort', 'pre-cort', 'authorized_payment', 'payment', 'active', now()
  ) into v_result;
  reset role;

  if v_result <> 'applied' then
    raise exception 'CASO 8: el webhook devolvió % en vez de applied.', v_result;
  end if;

  select * into v_row from public.tenants where id = v_tenant;

  if v_row.plan <> 'pro' then
    raise exception 'CASO 8: el webhook no movió el plan pagado (quedó %).', v_row.plan;
  end if;
  if v_row.plan_courtesy is distinct from 'premium' then
    raise exception 'CASO 8: la renovación se llevó puesta la cortesía (quedó %). El regalo duraba hasta el próximo cobro.', v_row.plan_courtesy;
  end if;
  if v_row.plan_courtesy_reason <> 'compensacion por caida' then
    raise exception 'CASO 8: se perdió el motivo del regalo.';
  end if;
end $$;

rollback;
