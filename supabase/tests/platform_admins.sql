-- ============================================================
-- Test SQL para 20260828120003_platform_admins.sql
--
-- Misma convención que close_only_ended_bookings.sql: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus propios datos,
-- todo dentro de una transacción con ROLLBACK al final.
--
-- Lo que se prueba acá NO es un trigger sino la RLS, así que los bloques
-- cambian de rol a `authenticated` y se "loguean" seteando el GUC que lee
-- `auth.uid()`. Correr como superusuario no probaría nada: el owner de la
-- tabla saltea RLS.
--
-- DOS REGLAS QUE SE SIGUEN EN TODOS LOS BLOQUES, y por qué:
--
-- 1. **Cada GRANT que hace un bloque, lo revoca antes de salir.** Todo corre
--    en UNA transacción, así que un grant que queda colgado se filtra a los
--    bloques siguientes y vuelve al orden de los bloques algo cargante y no
--    declarado: mover uno cambiaría en silencio lo que prueba la suite.
--
-- 2. **Ninguna assertion negativa viaja sola.** Un `count = 0` puede pasar
--    porque el aislamiento funcionó o porque el fixture nunca estuvo ahí, y
--    desde afuera se ven igual. Cada bloque que espera "no ve nada" lleva al
--    lado un control positivo que sí tiene que ver algo, y las búsquedas de
--    fixture chequean que encontraron fila.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/platform_admins.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: un usuario normal sigue viendo SÓLO sus negocios.
--         Es el test de NO regresión: auth_tenant_ids() cambió,
--         y el aislamiento de siempre tiene que seguir en pie.
-- ------------------------------------------------------------
do $$
declare
  v_user_a   uuid;
  v_user_b   uuid;
  v_tenant_a uuid;
  v_tenant_b uuid;
  v_visible  uuid[];
begin
  insert into auth.users (email) values ('a@test.com') returning id into v_user_a;
  insert into auth.users (email) values ('b@test.com') returning id into v_user_b;

  insert into public.tenants (slug, name, country)
    values ('pa-uno', 'Negocio A', 'AR') returning id into v_tenant_a;
  insert into public.tenants (slug, name, country)
    values ('pa-dos', 'Negocio B', 'AR') returning id into v_tenant_b;

  insert into public.memberships (user_id, tenant_id, role)
    values (v_user_a, v_tenant_a, 'owner');
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user_b, v_tenant_b, 'owner');

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  select array_agg(id order by id) into v_visible from public.auth_tenant_ids() as id;

  if v_visible is distinct from array[v_tenant_a] then
    raise exception 'Caso 1: el usuario A debía ver sólo su negocio, vio %', v_visible;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: un super admin ve TODOS los negocios, incluidos los
--         que nacieron después de que se lo nombró admin.
-- ------------------------------------------------------------
do $$
declare
  v_admin   uuid;
  v_total   int;
  v_visible int;
begin
  insert into auth.users (email) values ('root@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id) values (v_admin);

  -- Un negocio nuevo, creado DESPUÉS del alta del admin: no hace falta
  -- mantener ninguna fila de membresía para que lo vea.
  insert into public.tenants (slug, name, country) values ('pa-tres', 'Negocio C', 'AR');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  select count(*) into v_visible from public.auth_tenant_ids();
  select count(*) into v_total   from public.tenants;

  if v_visible <> v_total then
    raise exception 'Caso 2: el super admin debía ver los % negocios, vio %', v_total, v_visible;
  end if;
  -- Anti-vacuidad: si el fixture se vaciara, "los ve a todos" sería trivial.
  if v_total < 3 then
    raise exception 'Caso 2: el fixture esperaba al menos 3 negocios, hay %', v_total;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: un usuario sin membresías y sin admin no ve nada.
--         Cubre el borde del array vacío: la función devuelve
--         cero filas, no una fila NULL.
-- ------------------------------------------------------------
do $$
declare
  v_huerfano uuid;
  v_visible  int;
  v_nulos    int;
begin
  insert into auth.users (email) values ('nadie@test.com') returning id into v_huerfano;

  perform set_config('request.jwt.claim.sub', v_huerfano::text, true);
  select count(*) into v_visible from public.auth_tenant_ids();
  -- `count(*)` cuenta filas NULL igual, así que sola no distingue "cero filas"
  -- de "una fila NULL". Ésta sí: si saliera un NULL, acá se ve.
  select count(*) into v_nulos from public.auth_tenant_ids() as id where id is null;

  if v_visible <> 0 then
    raise exception 'Caso 3: un usuario sin negocios debía ver 0, vio %', v_visible;
  end if;
  if v_nulos <> 0 then
    raise exception 'Caso 3: la función devolvió % fila(s) NULL en vez de conjunto vacío', v_nulos;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: `authenticated` no tiene privilegios sobre platform_admins.
--         Primera barrera: el GRANT. Si esto se rompe, alguien le
--         devolvió permisos a la tabla desde PostgREST.
-- ------------------------------------------------------------
do $$
declare
  v_leyo boolean := false;
begin
  set local role authenticated;
  begin
    perform 1 from public.platform_admins;
    v_leyo := true;
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  if v_leyo then
    raise exception 'Caso 4: authenticated pudo consultar platform_admins; falta el revoke';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: aunque alguien le devuelva el GRANT, la RLS sigue tapando.
--         Segunda barrera, la que de verdad importa: nadie se
--         auto-promueve a super admin ni averigua quiénes son.
--
--         El grant se revoca al final del bloque a propósito: si
--         quedara puesto, el Caso 4 dejaría de ser cierto para todo
--         lo que corre después y el orden pasaría a ser load-bearing.
-- ------------------------------------------------------------
do $$
declare
  v_intruso  uuid;
  v_filas    int;
  v_reales   int;
  v_escribio boolean := false;
begin
  insert into auth.users (email) values ('intruso@test.com') returning id into v_intruso;

  -- Control positivo: como owner hay filas de verdad para tapar. Sin esto,
  -- el `= 0` de abajo podría estar mirando una tabla vacía.
  select count(*) into v_reales from public.platform_admins;
  if v_reales = 0 then
    raise exception 'Caso 5: el fixture esperaba al menos un admin cargado, hay 0';
  end if;

  grant select, insert, update, delete on public.platform_admins to authenticated;

  perform set_config('request.jwt.claim.sub', v_intruso::text, true);
  set local role authenticated;

  select count(*) into v_filas from public.platform_admins;

  begin
    insert into public.platform_admins (user_id) values (v_intruso);
    v_escribio := true;
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  revoke select, insert, update, delete on public.platform_admins from authenticated;

  if v_filas <> 0 then
    raise exception 'Caso 5: la RLS debía tapar las % filas reales, se leyeron %', v_reales, v_filas;
  end if;
  if v_escribio then
    raise exception 'Caso 5: un usuario cualquiera se auto-promovió a super admin';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: el super admin atraviesa una policy REAL de otro negocio.
--         Los casos anteriores prueban la función; éste prueba que
--         las policies existentes de verdad la heredan.
--
--         El `grant select on services` lo pone el bloque porque el
--         Postgres descartable no trae los default privileges que
--         Supabase ya aplicó en producción. O sea: acá se prueba la
--         capa de POLICY, no la de GRANT — que es la capa que este
--         cambio toca.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_dueno  uuid;
  v_ajeno  uuid;
  v_visto  int;
begin
  insert into auth.users (email) values ('root6@test.com') returning id into v_admin;
  insert into auth.users (email) values ('dueno6@test.com') returning id into v_dueno;
  insert into public.platform_admins (user_id) values (v_admin);

  insert into public.tenants (slug, name, country)
    values ('pa-ajeno', 'Negocio ajeno', 'AR') returning id into v_ajeno;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_dueno, v_ajeno, 'owner');
  insert into public.services (tenant_id, name, duration_min)
    values (v_ajeno, 'Corte ajeno', 30);

  grant select on public.services to authenticated;

  -- El admin NO es miembro de ese negocio y aun así lee su catálogo.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  select count(*) into v_visto from public.services where tenant_id = v_ajeno;
  reset role;

  revoke select on public.services from authenticated;

  if v_visto <> 1 then
    raise exception 'Caso 6: el super admin debía ver 1 servicio ajeno, vio %', v_visto;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: y el vecino NO. Que el admin pase no puede significar
--         que se aflojó el aislamiento para todo el mundo.
--
--         Este bloque es el único que prueba la no-regresión a
--         través de una policy, así que va blindado: chequea que
--         encontró el fixture ajeno (si `v_ajeno` fuera NULL, el
--         `tenant_id = NULL` daría 0 filas y el test pasaría sin
--         probar nada) y lleva un control positivo con lo propio.
-- ------------------------------------------------------------
do $$
declare
  v_vecino  uuid;
  v_propio  uuid;
  v_ajeno   uuid;
  v_visto   int;
  v_control int;
begin
  insert into auth.users (email) values ('vecino@test.com') returning id into v_vecino;

  insert into public.tenants (slug, name, country)
    values ('pa-propio', 'Negocio propio', 'AR') returning id into v_propio;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_vecino, v_propio, 'owner');
  insert into public.services (tenant_id, name, duration_min)
    values (v_propio, 'Corte propio', 30);

  select id into v_ajeno from public.tenants where slug = 'pa-ajeno';
  if v_ajeno is null then
    raise exception 'Caso 7: no apareció el negocio ajeno del Caso 6; el test no probaría nada';
  end if;

  grant select on public.services to authenticated;

  perform set_config('request.jwt.claim.sub', v_vecino::text, true);
  set local role authenticated;
  select count(*) into v_visto   from public.services where tenant_id = v_ajeno;
  select count(*) into v_control from public.services where tenant_id = v_propio;
  reset role;

  revoke select on public.services from authenticated;

  -- Control positivo primero: si el vecino tampoco ve lo suyo, el 0 de
  -- abajo no significa "aislamiento", significa "no llegué a la tabla".
  if v_control <> 1 then
    raise exception 'Caso 7: el vecino debía ver 1 servicio PROPIO, vio %', v_control;
  end if;
  if v_visto <> 0 then
    raise exception 'Caso 7: el vecino no debía ver nada ajeno, vio %', v_visto;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: EL CAMINO DE RECURSIÓN, ejercitado de verdad.
--
--         La migración afirma que `auth_tenant_ids()` puede leer
--         `tenants` aunque la policy de `tenants` llame a
--         `auth_tenant_ids()`, porque SECURITY DEFINER saltea RLS.
--         Los casos anteriores NO prueban eso: el Caso 2 llama a la
--         función como owner y el Caso 6 cruza la policy de
--         `services`, no la de `tenants`.
--
--         Acá se consulta `public.tenants` bajo `role authenticated`,
--         que es exactamente el camino que la afirmación cubre. Si
--         hubiera recursión, esto explota en vez de contar.
-- ------------------------------------------------------------
do $$
declare
  v_admin   uuid;
  v_normal  uuid;
  v_suyo    uuid;
  v_total   int;
  v_admin_ve  int;
  v_normal_ve int;
begin
  insert into auth.users (email) values ('root8@test.com') returning id into v_admin;
  insert into auth.users (email) values ('normal8@test.com') returning id into v_normal;
  insert into public.platform_admins (user_id) values (v_admin);

  insert into public.tenants (slug, name, country)
    values ('pa-ocho', 'Negocio Ocho', 'AR') returning id into v_suyo;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_normal, v_suyo, 'owner');

  select count(*) into v_total from public.tenants;

  grant select on public.tenants to authenticated;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  select count(*) into v_admin_ve from public.tenants;
  reset role;

  perform set_config('request.jwt.claim.sub', v_normal::text, true);
  set local role authenticated;
  select count(*) into v_normal_ve from public.tenants;
  reset role;

  revoke select on public.tenants from authenticated;

  if v_admin_ve <> v_total then
    raise exception 'Caso 8: el admin debía ver los % negocios por la policy de tenants, vio %', v_total, v_admin_ve;
  end if;
  -- El control que hace que lo de arriba signifique algo: el usuario normal
  -- cruza la MISMA policy y sale con uno solo.
  if v_normal_ve <> 1 then
    raise exception 'Caso 8: el usuario normal debía ver 1 negocio por la policy de tenants, vio %', v_normal_ve;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: el super admin ESCRIBE en un negocio ajeno.
--
--         La migración declara que el alcance es lectura Y
--         escritura, a propósito, porque varias policies son
--         `for all`. Sin este bloque esa mitad quedaba sin probar.
-- ------------------------------------------------------------
do $$
declare
  v_admin   uuid;
  v_ajeno   uuid;
  v_creo    int;
  v_vecino  uuid;
  v_escribio boolean := false;
begin
  insert into auth.users (email) values ('root9@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id) values (v_admin);

  select id into v_ajeno from public.tenants where slug = 'pa-ajeno';
  if v_ajeno is null then
    raise exception 'Caso 9: no apareció el negocio ajeno; el test no probaría nada';
  end if;

  grant select, insert on public.services to authenticated;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  insert into public.services (tenant_id, name, duration_min)
    values (v_ajeno, 'Servicio puesto por el admin', 45);
  select count(*) into v_creo from public.services
    where tenant_id = v_ajeno and name = 'Servicio puesto por el admin';
  reset role;

  -- Control: un usuario cualquiera NO puede hacer lo mismo. La escritura
  -- ajena es del admin, no de todo el mundo.
  select user_id into v_vecino from public.memberships
    where tenant_id <> v_ajeno limit 1;
  perform set_config('request.jwt.claim.sub', v_vecino::text, true);
  set local role authenticated;
  begin
    insert into public.services (tenant_id, name, duration_min)
      values (v_ajeno, 'Servicio colado', 45);
    v_escribio := true;
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  revoke select, insert on public.services from authenticated;

  if v_creo <> 1 then
    raise exception 'Caso 9: el admin debía poder crear un servicio ajeno, quedaron % filas', v_creo;
  end if;
  if v_escribio then
    raise exception 'Caso 9: un usuario común escribió en un negocio ajeno';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 10: sacar el permiso tiene efecto inmediato.
--
--          La migración vende el DELETE como la forma de revocar,
--          con efecto en la próxima consulta —ése es el argumento
--          por el que se eligió una tabla y no un claim en el JWT.
--          Acá se ejerce la dirección de vuelta, en la misma sesión.
-- ------------------------------------------------------------
do $$
declare
  v_ex     uuid;
  v_suyo   uuid;
  v_antes  int;
  v_despues int;
  v_total  int;
begin
  insert into auth.users (email) values ('ex@test.com') returning id into v_ex;
  insert into public.tenants (slug, name, country)
    values ('pa-diez', 'Negocio Diez', 'AR') returning id into v_suyo;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_ex, v_suyo, 'owner');

  insert into public.platform_admins (user_id) values (v_ex);

  perform set_config('request.jwt.claim.sub', v_ex::text, true);
  select count(*) into v_antes from public.auth_tenant_ids();
  select count(*) into v_total from public.tenants;

  delete from public.platform_admins where user_id = v_ex;

  select count(*) into v_despues from public.auth_tenant_ids();

  if v_antes <> v_total then
    raise exception 'Caso 10: como admin debía ver los % negocios, vio %', v_total, v_antes;
  end if;
  if v_despues <> 1 then
    raise exception 'Caso 10: revocado debía volver a su único negocio, vio %', v_despues;
  end if;
end $$;

rollback;
