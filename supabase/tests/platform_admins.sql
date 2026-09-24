-- ============================================================
-- Test SQL para 20260828120003_platform_admins.sql
--                y 20260908120001_super_admin_reads_the_list_only.sql
--
-- LA SEGUNDA MIGRACIÓN DIO VUELTA LA MITAD DE ESTE ARCHIVO, y conviene saberlo
-- antes de leerlo. 20260828120003 metió el alcance del operador ADENTRO de
-- `auth_tenant_ids()`, así que las 30 policies que la llaman lo heredaban:
-- lectura y escritura sobre cada fila de cada negocio. 20260908120001 lo sacó
-- de ahí y lo declaró policy por policy, en las dos que el panel necesita.
--
-- Los casos 2, 6, 9 y 10 afirmaban el alcance viejo y hoy afirman el nuevo. No
-- se borraron: un caso que decía "el admin ve el catálogo ajeno" y ahora dice
-- "no lo ve" es el mismo caso probando la misma frontera desde el otro lado, y
-- deja escrito qué cambió y por qué. Los casos 11 y 12 se agregaron para las
-- dos mitades nuevas — lo que el operador SÍ sigue viendo, y lo que dejó de
-- ver.
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
--    Desde 20260908120001 varios bloques esperan "no ve nada" del OPERADOR, y
--    ahí el control positivo no puede ser del mismo actor —sería contradecir
--    la afirmación—. Es una consulta directa, sin rol, que confirma que la
--    fila existe de verdad: el Caso 6 cuenta el servicio, el 12 el turno.
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
  insert into auth.users (id, email) values (gen_random_uuid(), 'a@test.com') returning id into v_user_a;
  insert into auth.users (id, email) values (gen_random_uuid(), 'b@test.com') returning id into v_user_b;

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
-- Caso 2: `auth_tenant_ids()` NO conoce al super admin.
--
--         Hasta 20260908120001 esta función tenía una rama que le
--         devolvía TODOS los negocios, y las 30 policies que la
--         llaman heredaban ese alcance sin nombrarlo. Ahora la
--         función significa una sola cosa —"de qué negocios sos
--         miembro"— y el alcance del operador está declarado policy
--         por policy, en las dos que lo necesitan.
--
--         Este caso es el que cierra la puerta: si alguien devuelve
--         la rama, acá se entera. El Caso 8 prueba el otro lado —que
--         el panel SIGUE viendo la lista— y los dos juntos son el
--         cambio entero.
-- ------------------------------------------------------------
do $$
declare
  v_admin   uuid;
  v_total   int;
  v_visible int;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'root@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id) values (v_admin);

  insert into public.tenants (slug, name, country) values ('pa-tres', 'Negocio C', 'AR');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  select count(*) into v_visible from public.auth_tenant_ids();
  select count(*) into v_total   from public.tenants;

  -- No es miembro de ninguno, así que la función no le da ninguno.
  if v_visible <> 0 then
    raise exception
      'Caso 2: auth_tenant_ids() le dio % negocios al super admin; volvió la rama ancha',
      v_visible;
  end if;
  -- Anti-vacuidad: si el fixture se vaciara, "no ve ninguno" sería trivial.
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
  insert into auth.users (id, email) values (gen_random_uuid(), 'nadie@test.com') returning id into v_huerfano;

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
  insert into auth.users (id, email) values (gen_random_uuid(), 'intruso@test.com') returning id into v_intruso;

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
-- Caso 6: el super admin NO entra al catálogo de otro negocio.
--
--         Antes de 20260908120001 sí entraba, y era el ejemplo que
--         probaba que las policies heredaban la rama ancha. Ahora
--         prueba lo contrario, que es el issue #50: el operador ve la
--         LISTA de negocios, no el adentro de ninguno.
--
--         `services` es el representante de las seis tablas que
--         perdieron al operador —bookings, staff, staff_services,
--         staff_availability, services y el bucket de logos—. Todas
--         dependen de la MISMA función, así que si vuelve a entrar
--         acá, vuelve a entrar en todas.
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
  v_real   int;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'root6@test.com') returning id into v_admin;
  insert into auth.users (id, email) values (gen_random_uuid(), 'dueno6@test.com') returning id into v_dueno;
  insert into public.platform_admins (user_id) values (v_admin);

  insert into public.tenants (slug, name, country)
    values ('pa-ajeno', 'Negocio ajeno', 'AR') returning id into v_ajeno;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_dueno, v_ajeno, 'owner');
  insert into public.services (tenant_id, name, duration_min)
    values (v_ajeno, 'Corte ajeno', 30);

  grant select on public.services to authenticated;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  select count(*) into v_visto from public.services where tenant_id = v_ajeno;
  reset role;

  revoke select on public.services from authenticated;

  -- Anti-vacuidad: la fila TIENE que existir, o "no vio nada" no prueba nada.
  select count(*) into v_real from public.services where tenant_id = v_ajeno;

  if v_real <> 1 then
    raise exception 'Caso 6: el fixture no dejó el servicio ajeno; el test no probaría nada';
  end if;
  if v_visto <> 0 then
    raise exception
      'Caso 6: el super admin leyó % servicio(s) de un negocio ajeno', v_visto;
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
  insert into auth.users (id, email) values (gen_random_uuid(), 'vecino@test.com') returning id into v_vecino;

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
  insert into auth.users (id, email) values (gen_random_uuid(), 'root8@test.com') returning id into v_admin;
  insert into auth.users (id, email) values (gen_random_uuid(), 'normal8@test.com') returning id into v_normal;
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
-- Caso 9: EL QUE MÁS IMPORTA — el super admin NO ESCRIBE en un
--         negocio ajeno.
--
--         20260828120003 declaraba el alcance como lectura Y
--         escritura, a propósito: varias policies son `for all`. Ésa
--         es la mitad que el issue #50 llamaba por su nombre — un
--         operador podía editar o borrar los turnos y el personal de
--         cualquier negocio, y no lo frenaba nada más que la ausencia
--         de una pantalla.
--
--         Lo que el operador SÍ hace hoy —cortesías y cupones— pasa
--         por funciones `security definer` que chequean
--         `is_super_admin()` adentro y dejan registro. Esta escritura
--         ancha era la segunda puerta al mismo cuarto, sin registro.
-- ------------------------------------------------------------
do $$
declare
  v_admin    uuid;
  v_ajeno    uuid;
  v_creo     int;
  v_escribio boolean := false;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'root9@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id) values (v_admin);

  select id into v_ajeno from public.tenants where slug = 'pa-ajeno';
  if v_ajeno is null then
    raise exception 'Caso 9: no apareció el negocio ajeno; el test no probaría nada';
  end if;

  grant select, insert on public.services to authenticated;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  begin
    insert into public.services (tenant_id, name, duration_min)
      values (v_ajeno, 'Servicio puesto por el admin', 45);
    v_escribio := true;
  exception
    -- La RLS rechaza un INSERT que no pasa el `with check` con este mismo
    -- código. Se atrapa por código y no con `when others` para no tragarse
    -- un fallo distinto —una columna que falta, por ejemplo— y leerlo como
    -- si la reja hubiera funcionado.
    when insufficient_privilege then null;
  end;
  reset role;

  revoke select, insert on public.services from authenticated;

  select count(*) into v_creo from public.services
    where tenant_id = v_ajeno and name = 'Servicio puesto por el admin';

  if v_escribio then
    raise exception 'Caso 9: el super admin pudo INSERTAR en un negocio ajeno';
  end if;
  if v_creo <> 0 then
    raise exception 'Caso 9: quedaron % filas escritas por el admin en un negocio ajeno', v_creo;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 10: sacar el permiso tiene efecto inmediato.
--
--          La migración vende el DELETE como la forma de revocar,
--          con efecto en la próxima consulta —ése es el argumento
--          por el que se eligió una tabla y no un claim en el JWT.
--          Acá se ejerce la dirección de vuelta, en la misma sesión.
--
--          Se mide contra la POLICY de `tenants` y ya no contra
--          `auth_tenant_ids()`: desde 20260908120001 la función no
--          sabe del operador, así que medirla ahí no probaría la
--          revocación, probaría el cambio de la función.
-- ------------------------------------------------------------
do $$
declare
  v_ex      uuid;
  v_suyo    uuid;
  v_antes   int;
  v_despues int;
  v_total   int;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'ex@test.com') returning id into v_ex;
  insert into public.tenants (slug, name, country)
    values ('pa-diez', 'Negocio Diez', 'AR') returning id into v_suyo;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_ex, v_suyo, 'owner');

  insert into public.platform_admins (user_id) values (v_ex);

  select count(*) into v_total from public.tenants;

  -- El grant lo pone el bloque porque el Postgres descartable no trae los
  -- default privileges que Supabase ya aplicó. Mismo motivo que el Caso 8:
  -- lo que se prueba acá es la capa de POLICY, no la de GRANT.
  grant select on public.tenants to authenticated;

  perform set_config('request.jwt.claim.sub', v_ex::text, true);
  set local role authenticated;
  select count(*) into v_antes from public.tenants;
  reset role;

  delete from public.platform_admins where user_id = v_ex;

  set local role authenticated;
  select count(*) into v_despues from public.tenants;
  reset role;

  revoke select on public.tenants from authenticated;

  if v_antes <> v_total then
    raise exception 'Caso 10: como admin debía ver los % negocios, vio %', v_total, v_antes;
  end if;
  if v_despues <> 1 then
    raise exception 'Caso 10: revocado debía volver a su único negocio, vio %', v_despues;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 11: el operador SÍ ve las suscripciones de todos.
--
--          Es la otra mitad de lo que el panel necesita, y la que
--          contesta las preguntas por las que existe: quién está en
--          prueba, a quién le falló el cobro, quién se dio de baja.
--          Sin esta policy el detalle del negocio queda vacío.
-- ------------------------------------------------------------
do $$
declare
  v_admin uuid;
  v_ajeno uuid;
  v_ve    int;
  v_total int;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'root11@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id) values (v_admin);

  -- El fixture inserta los negocios a mano, sin pasar por `create_business`,
  -- así que no hay ninguna suscripción hasta que este bloque la ponga. Lo
  -- descubrió el guardián anti-vacuidad de más abajo, que es para lo que está.
  select id into v_ajeno from public.tenants where slug = 'pa-ajeno';
  insert into public.subscriptions (
    tenant_id, plan, status, current_period_end, price_usd_cents
  ) values (
    v_ajeno, 'pro', 'active', now() + interval '25 days', 3500
  );

  grant select on public.subscriptions to authenticated;

  select count(*) into v_total from public.subscriptions;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  select count(*) into v_ve from public.subscriptions;
  reset role;

  revoke select on public.subscriptions from authenticated;

  if v_total < 1 then
    raise exception 'Caso 11: el fixture no dejó ninguna suscripción; el test no probaría nada';
  end if;
  if v_ve <> v_total then
    raise exception 'Caso 11: el operador debía ver las % suscripciones, vio %', v_total, v_ve;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 12: y NO ve la agenda de nadie.
--
--          `bookings` es lo más sensible que hay en la base —nombres
--          y teléfonos de los clientes de otro— y era alcanzable con
--          un `fetch` desde la consola del browser. Es la tabla que
--          el issue #50 nombra primero.
-- ------------------------------------------------------------
do $$
declare
  v_admin  uuid;
  v_ajeno  uuid;
  v_staff  uuid;
  v_serv   uuid;
  v_ve     int;
  v_real   int;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'root12@test.com') returning id into v_admin;
  insert into public.platform_admins (user_id) values (v_admin);

  select id into v_ajeno from public.tenants where slug = 'pa-ajeno';
  select id into v_serv  from public.services where tenant_id = v_ajeno limit 1;
  insert into public.staff (tenant_id, name) values (v_ajeno, 'Ana') returning id into v_staff;

  insert into public.bookings (
    tenant_id, staff_id, service_id, starts_at, ends_at,
    customer_name, customer_phone
  ) values (
    v_ajeno, v_staff, v_serv,
    now() + interval '2 days', now() + interval '2 days 30 minutes',
    'Cliente Ajeno', '1122334455'
  );

  grant select on public.bookings to authenticated;

  select count(*) into v_real from public.bookings where tenant_id = v_ajeno;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  select count(*) into v_ve from public.bookings where tenant_id = v_ajeno;
  reset role;

  revoke select on public.bookings from authenticated;

  if v_real < 1 then
    raise exception 'Caso 12: el fixture no dejó ningún turno; el test no probaría nada';
  end if;
  if v_ve <> 0 then
    raise exception
      'Caso 12: el operador leyó % turno(s) ajenos, con nombre y teléfono del cliente', v_ve;
  end if;
end $$;

rollback;
