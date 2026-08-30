-- ============================================================
-- Test SQL para 20260830120003_coupons.sql
--
-- Misma convención que platform_admins.sql: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus datos, todo en una
-- transacción con ROLLBACK.
--
-- Lo que más se cuida acá es que un rechazo NO consuma un canje. Un cupón que
-- se agota con intentos fallidos es peor que uno que no existe: se apaga solo,
-- en silencio, y el que lo escribió bien se queda sin descuento.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/coupons.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: un canje válido devuelve el descuento y cuenta uno.
-- ------------------------------------------------------------
do $$
declare
  v_discount int;
  v_count    int;
begin
  insert into public.coupons (code, discount_bps, note)
    values ('BETA99', 9900, 'prueba de cobro real');

  select public.redeem_coupon('BETA99') into v_discount;
  select redemptions into v_count from public.coupons where code = 'BETA99';

  if v_discount is distinct from 9900 then
    raise exception 'CASO 1: devolvió % en vez de 9900.', v_discount;
  end if;
  if v_count <> 1 then
    raise exception 'CASO 1: contó % canjes en vez de 1.', v_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: el código se normaliza.
--         Quien lo tipea lo copia de un mail o de un papel, y
--         las mayúsculas no son una decisión de nadie.
-- ------------------------------------------------------------
do $$
declare
  v_min  int;
  v_pad  int;
  v_mix  int;
begin
  insert into public.coupons (code, discount_bps) values ('VERANO', 2000);

  select public.redeem_coupon('verano')     into v_min;
  select public.redeem_coupon('  VERANO  ') into v_pad;
  select public.redeem_coupon('VeRaNo')     into v_mix;

  if v_min is null or v_pad is null or v_mix is null then
    raise exception 'CASO 2: alguna variante no canjeó (min=% pad=% mix=%).', v_min, v_pad, v_mix;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: apagado, vencido, agotado e inexistente dan null.
--         Y NINGUNO consume un canje.
--
--         Lo segundo es lo que hay que fijar: si un rechazo
--         contara, cualquiera agota un cupón ajeno tipeándolo
--         mal a propósito.
-- ------------------------------------------------------------
do $$
declare
  v_apagado  int;
  v_vencido  int;
  v_agotado  int;
  v_no_existe int;
  v_c_apagado int;
  v_c_vencido int;
  v_c_agotado int;
begin
  insert into public.coupons (code, discount_bps, active)
    values ('APAGADO', 1000, false);
  insert into public.coupons (code, discount_bps, expires_at)
    values ('VENCIDO', 1000, now() - interval '1 day');
  insert into public.coupons (code, discount_bps, max_redemptions, redemptions)
    values ('AGOTADO', 1000, 2, 2);

  select public.redeem_coupon('APAGADO')  into v_apagado;
  select public.redeem_coupon('VENCIDO')  into v_vencido;
  select public.redeem_coupon('AGOTADO')  into v_agotado;
  select public.redeem_coupon('NOEXISTE') into v_no_existe;

  if v_apagado is not null then raise exception 'CASO 3: un cupón apagado canjeó.'; end if;
  if v_vencido is not null then raise exception 'CASO 3: un cupón vencido canjeó.'; end if;
  if v_agotado is not null then raise exception 'CASO 3: un cupón agotado canjeó.'; end if;
  if v_no_existe is not null then raise exception 'CASO 3: un código inexistente canjeó.'; end if;

  select redemptions into v_c_apagado from public.coupons where code = 'APAGADO';
  select redemptions into v_c_vencido from public.coupons where code = 'VENCIDO';
  select redemptions into v_c_agotado from public.coupons where code = 'AGOTADO';

  if v_c_apagado <> 0 or v_c_vencido <> 0 then
    raise exception 'CASO 3: un rechazo consumió un canje (apagado=% vencido=%).', v_c_apagado, v_c_vencido;
  end if;
  if v_c_agotado <> 2 then
    raise exception 'CASO 3: el agotado pasó de 2 a %.', v_c_agotado;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: el tope se respeta EXACTAMENTE en el borde.
--
--         Se canjea hasta el tope y uno más. Un off-by-one acá
--         regala un mes de más por cupón, y con un cupón del
--         99% eso es una suscripción que no cobra nada.
-- ------------------------------------------------------------
do $$
declare
  v_uno  int;
  v_dos  int;
  v_tres int;
  v_count int;
begin
  insert into public.coupons (code, discount_bps, max_redemptions)
    values ('DOSUSOS', 5000, 2);

  select public.redeem_coupon('DOSUSOS') into v_uno;
  select public.redeem_coupon('DOSUSOS') into v_dos;
  select public.redeem_coupon('DOSUSOS') into v_tres;

  if v_uno is null or v_dos is null then
    raise exception 'CASO 4: se rechazó un canje que estaba dentro del tope (1=% 2=%).', v_uno, v_dos;
  end if;
  if v_tres is not null then
    raise exception 'CASO 4: el tercer canje pasó con un tope de 2.';
  end if;

  select redemptions into v_count from public.coupons where code = 'DOSUSOS';
  if v_count <> 2 then
    raise exception 'CASO 4: quedó en % canjes.', v_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: un cupón sin tope no se agota.
-- ------------------------------------------------------------
do $$
declare
  v_ultimo int;
begin
  insert into public.coupons (code, discount_bps) values ('SINTOPE', 1500);

  for i in 1..5 loop
    select public.redeem_coupon('SINTOPE') into v_ultimo;
  end loop;

  if v_ultimo is null then
    raise exception 'CASO 5: un cupón sin tope se agotó.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: el cupón queda CONGELADO en la fila de identidad.
--
--         Es la razón de ser de la columna. Si el descuento se
--         leyera de `coupons` en cada renovación, apagar un
--         cupón le subiría el precio a todos los que ya lo
--         usaron, sin avisarles.
-- ------------------------------------------------------------
do $$
declare
  v_tenant uuid;
  v_sub    uuid;
  v_ok     boolean;
  v_ref    public.subscription_provider_refs;
begin
  insert into public.tenants (slug, name, country)
    values ('cup-uno', 'Negocio Cupón', 'AR') returning id into v_tenant;
  insert into public.subscriptions (
    tenant_id, plan, status, current_period_end, price_usd_cents
  )
  values (v_tenant, 'basico', 'trialing', now() + interval '14 days', 1000)
  returning id into v_sub;

  select public.attach_subscription_checkout(
    v_tenant, v_sub, 'pro', 3500, 23111, 1500, 'dolarapi:bolsa', now(),
    'mercadopago', 'pre-cup-1', 'BETA99', 9900
  ) into v_ok;

  if not v_ok then
    raise exception 'CASO 6: attach devolvió false.';
  end if;

  select * into v_ref from public.subscription_provider_refs
   where provider_subscription_id = 'pre-cup-1';

  if v_ref.coupon_code is distinct from 'BETA99' then
    raise exception 'CASO 6: el cupón no quedó congelado (quedó %).', v_ref.coupon_code;
  end if;
  if v_ref.discount_bps is distinct from 9900 then
    raise exception 'CASO 6: el descuento no quedó congelado (quedó %).', v_ref.discount_bps;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: sin cupón, las dos columnas quedan en null.
--         NO REGRESIÓN: el checkout sin cupón es el camino
--         normal y tiene que seguir andando igual.
-- ------------------------------------------------------------
do $$
declare
  v_tenant uuid;
  v_sub    uuid;
  v_ok     boolean;
  v_ref    public.subscription_provider_refs;
begin
  insert into public.tenants (slug, name, country)
    values ('cup-dos', 'Negocio Sin Cupón', 'AR') returning id into v_tenant;
  insert into public.subscriptions (
    tenant_id, plan, status, current_period_end, price_usd_cents
  )
  values (v_tenant, 'basico', 'trialing', now() + interval '14 days', 1000)
  returning id into v_sub;

  select public.attach_subscription_checkout(
    v_tenant, v_sub, 'pro', 3500, 2311100, 1500, 'dolarapi:bolsa', now(),
    'mercadopago', 'pre-cup-2'
  ) into v_ok;

  if not v_ok then
    raise exception 'CASO 7: attach sin cupón devolvió false.';
  end if;

  select * into v_ref from public.subscription_provider_refs
   where provider_subscription_id = 'pre-cup-2';

  if v_ref.coupon_code is not null or v_ref.discount_bps is not null then
    raise exception 'CASO 7: quedó un cupón fantasma (% / %).', v_ref.coupon_code, v_ref.discount_bps;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: la tabla NO se lee desde una sesión, y la función de
--         canje NO se llama desde una sesión.
--
--         Una lista de cupones legible es una lista de códigos
--         de descuento publicada. Y un canje al alcance de una
--         sesión permite contar canjes sin abrir jamás un
--         preapproval: con eso se agota un cupón ajeno.
-- ------------------------------------------------------------
do $$
declare
  v_user       uuid;
  v_leyo       boolean := false;
  v_canjeo     boolean := false;
begin
  insert into auth.users (email) values ('cupon@test.com') returning id into v_user;
  insert into public.coupons (code, discount_bps) values ('SECRETO', 9900);

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  begin
    perform 1 from public.coupons;
    v_leyo := true;
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.redeem_coupon('SECRETO');
    v_canjeo := true;
  exception when insufficient_privilege then
    null;
  end;

  reset role;

  if v_leyo then
    raise exception 'CASO 8: un usuario logueado pudo LEER la tabla de cupones.';
  end if;
  if v_canjeo then
    raise exception 'CASO 8: un usuario logueado pudo canjear directamente.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: no se puede crear un cupón del 100%.
--         Dejaría el preapproval en cero y Mercado Pago lo
--         rechaza: fallaría recién en el checkout, de cara al
--         cliente.
-- ------------------------------------------------------------
do $$
declare
  v_rechazado boolean := false;
begin
  begin
    insert into public.coupons (code, discount_bps) values ('GRATIS', 10000);
  exception when check_violation then
    v_rechazado := true;
  end;

  if not v_rechazado then
    raise exception 'CASO 9: se creó un cupón del 100%%.';
  end if;

  -- Control positivo: 9900 sí entra, así que el rechazo es por el techo y no
  -- porque el insert esté mal armado.
  insert into public.coupons (code, discount_bps) values ('CASIGRATIS', 9900);
end $$;

rollback;
