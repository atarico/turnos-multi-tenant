-- ============================================================
-- Test SQL para 20260830120001_tenants_column_grants.sql
--
-- Misma convención que platform_admins.sql: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus propios datos, todo
-- dentro de una transacción con ROLLBACK al final, y los bloques cambian de rol
-- a `authenticated` seteando el GUC que lee `auth.uid()`. Correr como
-- superusuario no probaría nada: el owner de la tabla saltea RLS *y* los grants.
--
-- LA REGLA QUE MÁS IMPORTA ACÁ: ninguna assertion negativa viaja sola.
--
-- "El update falló" puede pasar porque el grant lo frenó o porque el fixture
-- estaba mal armado y la fila nunca existió, y desde afuera se ven idénticos.
-- Por eso cada bloque que espera un rechazo lleva al lado un control positivo
-- —una columna que SÍ se tiene que poder escribir, sobre la MISMA fila y en la
-- MISMA sesión— y verifica que el valor efectivamente cambió.
--
-- Sin ese control, esta suite entera pasaría en verde contra una base donde
-- `authenticated` no puede escribir absolutamente nada, que es un bug distinto
-- y peor: rompe el guardado de configuración de todos los negocios.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenants_column_grants.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: el dueño SIGUE pudiendo editar su marca.
--         Control positivo de toda la suite: si esto falla, el
--         revoke se pasó de largo y rompió /panel/configuracion.
-- ------------------------------------------------------------
do $$
declare
  v_user   uuid;
  v_tenant uuid;
  v_color  text;
  v_logo   text;
begin
  insert into auth.users (email) values ('marca@test.com') returning id into v_user;
  insert into public.tenants (slug, name, country)
    values ('grants-marca', 'Negocio Marca', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner');

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  update public.tenants set brand_color = '#123456' where id = v_tenant;
  update public.tenants set logo_url = 'https://x/y.png' where id = v_tenant;

  reset role;

  select brand_color, logo_url into v_color, v_logo
    from public.tenants where id = v_tenant;

  if v_color is distinct from '#123456' then
    raise exception 'CASO 1: el dueño no pudo cambiar brand_color (quedó %). El revoke rompió la pantalla de configuración.', v_color;
  end if;
  if v_logo is distinct from 'https://x/y.png' then
    raise exception 'CASO 1: el dueño no pudo cambiar logo_url (quedó %).', v_logo;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: EL AGUJERO. El dueño NO puede subirse de plan.
--         Antes de esta migración este update pasaba y el
--         negocio quedaba en premium sin haber pagado nada.
-- ------------------------------------------------------------
do $$
declare
  v_user     uuid;
  v_tenant   uuid;
  v_plan     public.plan_tier;
  v_color    text;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('plan@test.com') returning id into v_user;
  insert into public.tenants (slug, name, country)
    values ('grants-plan', 'Negocio Plan', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner');

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  -- Control positivo EN LA MISMA SESIÓN: prueba que el rol puede escribir esta
  -- fila. Sin esto, el rechazo de abajo no distingue "no podés esta columna"
  -- de "no podés esta fila".
  update public.tenants set brand_color = '#abcdef' where id = v_tenant;

  begin
    update public.tenants set plan = 'premium' where id = v_tenant;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 2: el dueño PUDO escribir tenants.plan. El agujero sigue abierto.';
  end if;

  select plan, brand_color into v_plan, v_color
    from public.tenants where id = v_tenant;

  if v_plan <> 'basico' then
    raise exception 'CASO 2: el plan quedó en % en vez de basico.', v_plan;
  end if;
  if v_color is distinct from '#abcdef' then
    raise exception 'CASO 2: el control positivo falló (brand_color quedó %). El rechazo de arriba no prueba nada.', v_color;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: tampoco puede pisar el slug.
--         El slug es la URL pública del negocio: pisarlo es
--         mudarse de dirección, y apropiarse de una libre.
-- ------------------------------------------------------------
do $$
declare
  v_user      uuid;
  v_tenant    uuid;
  v_slug      text;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('slug@test.com') returning id into v_user;
  insert into public.tenants (slug, name, country)
    values ('grants-slug', 'Negocio Slug', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner');

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  update public.tenants set brand_color = '#fedcba' where id = v_tenant;

  begin
    update public.tenants set slug = 'robado' where id = v_tenant;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 3: el dueño PUDO cambiar su slug.';
  end if;

  select slug into v_slug from public.tenants where id = v_tenant;
  if v_slug <> 'grants-slug' then
    raise exception 'CASO 3: el slug quedó en % .', v_slug;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: un SUPER ADMIN tampoco escribe el plan a mano.
--
--         auth_tenant_ids() le devuelve todos los negocios, así
--         que la policy lo deja pasar sobre cualquier fila. Lo
--         que lo frena es el grant, y tiene que frenarlo: una
--         cortesía que se otorga con un PATCH suelto no deja
--         registro de quién la dio ni por qué. Eso va a salir
--         por una función security definer, no por acá.
-- ------------------------------------------------------------
do $$
declare
  v_admin     uuid;
  v_tenant    uuid;
  v_plan      public.plan_tier;
  v_color     text;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('admin@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');
  insert into public.tenants (slug, name, country)
    values ('grants-ajeno', 'Negocio Ajeno', 'AR') returning id into v_tenant;
  -- Sin membership: el operador no es miembro de ningún negocio, por diseño.

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  -- Control positivo: el operador SÍ alcanza esta fila (RLS lo deja), así que
  -- el rechazo de abajo es por columna y no por aislamiento.
  update public.tenants set brand_color = '#0f0f0f' where id = v_tenant;

  begin
    update public.tenants set plan = 'premium' where id = v_tenant;
  exception when insufficient_privilege then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 4: el super admin PUDO escribir tenants.plan con un update pelado.';
  end if;

  select plan, brand_color into v_plan, v_color
    from public.tenants where id = v_tenant;

  if v_plan <> 'basico' then
    raise exception 'CASO 4: el plan quedó en %.', v_plan;
  end if;
  if v_color is distinct from '#0f0f0f' then
    raise exception 'CASO 4: el control positivo falló: el operador ni siquiera alcanzaba la fila, así que el rechazo no prueba nada sobre la columna.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: EL NO-REGRESIÓN QUE MÁS IMPORTA.
--
--         El webhook TIENE que seguir moviendo el plan. Si el
--         revoke lo alcanzara, un cobro que entra no se aplica:
--         el cliente paga y no recibe nada, que es peor que el
--         agujero que esta migración cierra.
--
--         Se llama como `service_role`, que es el rol real del
--         webhook: usa `createAdminClient()` y la función tiene
--         el execute concedido SÓLO a ese rol
--         (`revoke ... from public, anon, authenticated`).
--
--         La primera versión de este test la llamaba como
--         `authenticated` y falló con "permission denied for
--         function". El que estaba mal era el test: probaba un
--         camino que en producción no existe.
-- ------------------------------------------------------------
do $$
declare
  v_tenant   uuid;
  v_sub      uuid;
  v_result   text;
  v_plan     public.plan_tier;
begin
  insert into public.tenants (slug, name, country, plan)
    values ('grants-webhook', 'Negocio Webhook', 'AR', 'basico')
    returning id into v_tenant;

  insert into public.subscriptions (
    tenant_id, plan, status, current_period_end, price_usd_cents
  )
  values (v_tenant, 'basico', 'active', now() + interval '1 month', 1000)
  returning id into v_sub;

  insert into public.subscription_provider_refs (
    provider, provider_subscription_id, subscription_id, tenant_id, plan
  )
  values ('mercadopago', 'pre-123', v_sub, v_tenant, 'premium');

  set local role service_role;

  select public.apply_subscription_payment(
    'mercadopago', 'evt-1', 'pre-123', 'authorized_payment', 'payment', 'active', now()
  ) into v_result;

  reset role;

  if v_result <> 'applied' then
    raise exception 'CASO 5: el webhook devolvió % en vez de applied. El revoke alcanzó a la función security definer y los cobros dejaron de aplicarse.', v_result;
  end if;

  select plan into v_plan from public.tenants where id = v_tenant;
  if v_plan <> 'premium' then
    raise exception 'CASO 5: el webhook no pudo escribir tenants.plan (quedó %). Un cobro entra y el negocio no recibe su plan.', v_plan;
  end if;
end $$;

rollback;
