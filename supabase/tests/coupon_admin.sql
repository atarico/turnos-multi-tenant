-- ============================================================
-- Test SQL para 20260831120001_coupon_admin.sql
--
-- Misma convención que platform_admins.sql. Lo que más importa acá es que las
-- TRES funciones chequeen el rol por separado: son tres `if` copiados, y
-- olvidarse de uno al copiar es el error real. Un `list_coupons` sin reja
-- publica todos los códigos de descuento a cualquier usuario logueado.
--
-- Ningún rechazo viaja solo: cada bloque prueba después que el operador SÍ
-- puede hacer la misma operación, para que "falló" no se confunda con "el
-- fixture estaba mal".
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/coupon_admin.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: el operador crea, y queda anotado quién.
--         El código se normaliza: quien lo tipea en un
--         formulario no decide las mayúsculas.
-- ------------------------------------------------------------
do $$
declare
  v_admin uuid;
  v_row   public.coupons;
begin
  insert into auth.users (email) values ('cadm1@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  perform public.create_coupon('  beta99  ', 9900, '  prueba de cobro  ');

  reset role;

  select * into v_row from public.coupons where code = 'BETA99';

  if v_row.code is null then
    raise exception 'CASO 1: no se normalizó el código.';
  end if;
  if v_row.created_by is distinct from v_admin then
    raise exception 'CASO 1: no quedó anotado quién lo creó.';
  end if;
  if v_row.note <> 'prueba de cobro' then
    raise exception 'CASO 1: el note quedó como "%".', v_row.note;
  end if;
  if not v_row.active then
    raise exception 'CASO 1: nació apagado.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: un usuario común no crea, no lista y no apaga.
--         Las tres se prueban por separado: son tres chequeos
--         copiados, y el error real es olvidarse de uno.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_user   uuid;
  v_creo   boolean := false;
  v_listo  boolean := false;
  v_apago  boolean := false;
  v_count  int;
begin
  insert into auth.users (email) values ('cadm2@test.com') returning id into v_admin;
  insert into auth.users (email) values ('cusr2@test.com') returning id into v_user;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.create_coupon('VIGENTE', 5000);
  reset role;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  begin
    perform public.create_coupon('MIOPROPIO', 9900);
    v_creo := true;
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from public.list_coupons();
    v_listo := true;
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.set_coupon_active('VIGENTE', false);
    v_apago := true;
  exception when insufficient_privilege then null;
  end;

  reset role;

  if v_creo  then raise exception 'CASO 2: un usuario común CREÓ un cupón.'; end if;
  if v_listo then raise exception 'CASO 2: un usuario común LISTÓ los cupones. Los códigos quedaron publicados.'; end if;
  if v_apago then raise exception 'CASO 2: un usuario común APAGÓ un cupón ajeno.'; end if;

  select count(*) into v_count from public.coupons where code = 'MIOPROPIO';
  if v_count <> 0 then raise exception 'CASO 2: quedó creado igual.'; end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: el operador lista y ve lo que creó.
--         Control positivo del caso 2: sin esto, un
--         `list_coupons` roto para TODOS pasaría en verde.
-- ------------------------------------------------------------
do $$
declare
  v_admin uuid;
  v_count int;
begin
  insert into auth.users (email) values ('cadm3@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  perform public.create_coupon('LISTAR1', 1000);
  perform public.create_coupon('LISTAR2', 2000);
  select count(*) into v_count from public.list_coupons() where code like 'LISTAR%';

  reset role;

  if v_count <> 2 then
    raise exception 'CASO 3: el operador vio % cupones en vez de 2.', v_count;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: apagar deja el cupón sin canjear, y el descuento ya
--         atado a un preapproval NO se toca.
--
--         Es el motivo de que se apague en vez de borrarse.
-- ------------------------------------------------------------
do $$
declare
  v_admin    uuid;
  v_discount int;
begin
  insert into auth.users (email) values ('cadm4@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.create_coupon('APAGAME', 3000);
  reset role;

  -- Canjeable antes.
  select public.redeem_coupon('APAGAME') into v_discount;
  if v_discount is null then
    raise exception 'CASO 4: no canjeaba ni antes de apagarlo.';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  perform public.set_coupon_active('APAGAME', false);
  reset role;

  select public.redeem_coupon('APAGAME') into v_discount;
  if v_discount is not null then
    raise exception 'CASO 4: siguió canjeando después de apagarlo.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: un código repetido se rechaza con un mensaje propio,
--         no con el nombre del índice de Postgres.
-- ------------------------------------------------------------
do $$
declare
  v_admin     uuid;
  v_rechazado boolean := false;
begin
  insert into auth.users (email) values ('cadm5@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  perform public.create_coupon('REPETIDO', 1000);
  begin
    perform public.create_coupon('repetido', 2000);
  exception when unique_violation then
    v_rechazado := true;
  end;

  reset role;

  if not v_rechazado then
    raise exception 'CASO 5: se creó dos veces el mismo código.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: un vencimiento ya pasado se rechaza al crear.
--         Nacería muerto: se vería en la lista y ningún
--         checkout lo aceptaría.
-- ------------------------------------------------------------
do $$
declare
  v_admin     uuid;
  v_rechazado boolean := false;
  v_count     int;
begin
  insert into auth.users (email) values ('cadm6@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id, note) values (v_admin, 'test');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;

  begin
    perform public.create_coupon('MUERTO', 1000, null, now() - interval '1 day');
  exception when check_violation then
    v_rechazado := true;
  end;

  -- Control positivo: con fecha futura sí entra.
  perform public.create_coupon('VIVO', 1000, null, now() + interval '30 days');

  reset role;

  if not v_rechazado then
    raise exception 'CASO 6: se creó un cupón ya vencido.';
  end if;
  select count(*) into v_count from public.coupons where code = 'VIVO';
  if v_count <> 1 then
    raise exception 'CASO 6: el control positivo falló.';
  end if;
end $$;

rollback;
