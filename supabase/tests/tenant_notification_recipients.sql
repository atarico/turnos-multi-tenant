-- ============================================================
-- Test SQL para 20260911120001_notify_tenant_of_new_booking.sql
--
-- Misma convención que `tenants_column_grants.sql` y `booking_reminders.sql`:
-- assertions con `do $$ ... raise exception ... $$`, cada bloque arma sus
-- propios datos, todo en una transacción con ROLLBACK al final.
--
-- Lo que este archivo defiende, que un test feliz no ve:
--
-- 1. QUE `staff` QUEDE AFUERA. Caso 3. No es un descuido: son quienes
--    atienden turnos puntuales, no quienes administran el negocio, y esta
--    función decide A PROPÓSITO no avisarles de cada reserva nueva del local
--    entero.
--
-- 2. AISLAMIENTO ENTRE NEGOCIOS. Caso 4, el que más importa acá: esto es un
--    SaaS multi-tenant, y la función cruza `memberships` con `auth.users` sin
--    pasar por RLS (`security definer`). Si el filtro por `tenant_id` fallara,
--    el dueño de un negocio se enteraría de las reservas de OTRO.
--
-- 3. QUE EL PERMISO SE PRUEBE, NO SE LEA. Casos 8 y 9: corren con
--    `set local role anon` / `authenticated` y esperan que la llamada
--    directamente EXPLOTE con `insufficient_privilege`. Leer la tabla de
--    grants no alcanza — ya pasó antes en este proyecto (issue #50, y de
--    nuevo en 20260908120001) que el grant decía una cosa y el comportamiento
--    real era otro. El caso 10 prueba el positivo: `service_role`, que es
--    quien realmente la llama desde el servidor, sí puede.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/tenant_notification_recipients.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Caso 1: el owner del negocio recibe su mail.
-- ------------------------------------------------------------
do $$
declare
  v_user   uuid;
  v_tenant uuid;
  v_emails text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'owner@test.com') returning id into v_user;
  insert into public.tenants (slug, name, country)
    values ('notif-owner', 'Negocio Owner', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v_tenant, 'owner');

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_tenant);

  if v_emails is distinct from array['owner@test.com'] then
    raise exception 'CASO 1: se esperaba el mail del owner y salió %', v_emails;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: el admin también recibe el aviso, junto con el owner.
-- ------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_admin  uuid;
  v_tenant uuid;
  v_emails text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'owner2@test.com') returning id into v_owner;
  insert into auth.users (id, email) values (gen_random_uuid(), 'admin2@test.com') returning id into v_admin;
  insert into public.tenants (slug, name, country)
    values ('notif-admin', 'Negocio Admin', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role) values
    (v_owner, v_tenant, 'owner'),
    (v_admin, v_tenant, 'admin');

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_tenant);

  if v_emails is distinct from array['admin2@test.com', 'owner2@test.com'] then
    raise exception 'CASO 2: se esperaban owner y admin y salió %', v_emails;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: `staff` NO recibe el aviso. Decisión de producto a propósito,
--         no un descuido: atienden turnos puntuales, no administran el
--         negocio.
-- ------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_staff  uuid;
  v_tenant uuid;
  v_emails text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'owner3@test.com') returning id into v_owner;
  insert into auth.users (id, email) values (gen_random_uuid(), 'staff3@test.com') returning id into v_staff;
  insert into public.tenants (slug, name, country)
    values ('notif-staff', 'Negocio Staff', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role) values
    (v_owner, v_tenant, 'owner'),
    (v_staff, v_tenant, 'staff');

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_tenant);

  if v_emails is distinct from array['owner3@test.com'] then
    raise exception 'CASO 3: staff se coló en el aviso, salió %', v_emails;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: AISLAMIENTO ENTRE NEGOCIOS. El que más importa: esto es
--         multi-tenant, y la función cruza memberships con auth.users
--         SIN pasar por RLS (security definer). Un miembro de OTRO negocio
--         nunca puede aparecer en la lista de éste.
-- ------------------------------------------------------------
do $$
declare
  v_owner_propio uuid;
  v_owner_ajeno  uuid;
  v_propio       uuid;
  v_ajeno        uuid;
  v_emails       text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'propio4@test.com') returning id into v_owner_propio;
  insert into auth.users (id, email) values (gen_random_uuid(), 'ajeno4@test.com') returning id into v_owner_ajeno;

  insert into public.tenants (slug, name, country)
    values ('notif-propio', 'Negocio Propio', 'AR') returning id into v_propio;
  insert into public.tenants (slug, name, country)
    values ('notif-ajeno', 'Negocio Ajeno', 'AR') returning id into v_ajeno;

  insert into public.memberships (user_id, tenant_id, role)
    values (v_owner_propio, v_propio, 'owner');
  insert into public.memberships (user_id, tenant_id, role)
    values (v_owner_ajeno, v_ajeno, 'owner');

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_propio);

  if v_emails is distinct from array['propio4@test.com'] then
    raise exception
      'CASO 4: el negocio ajeno se filtró en la lista de otro negocio, salió %', v_emails;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: sin mail verificado no hay a dónde avisar. Una cuenta puede
--         existir sin mail (alta por teléfono, por ejemplo).
-- ------------------------------------------------------------
do $$
declare
  v_con_mail uuid;
  v_sin_mail uuid;
  v_tenant   uuid;
  v_emails   text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'conmail5@test.com') returning id into v_con_mail;
  insert into auth.users (id, email) values (gen_random_uuid(), null) returning id into v_sin_mail;
  insert into public.tenants (slug, name, country)
    values ('notif-nomail', 'Negocio Sin Mail', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role) values
    (v_con_mail, v_tenant, 'owner'),
    (v_sin_mail, v_tenant, 'admin');

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_tenant);

  if v_emails is distinct from array['conmail5@test.com'] then
    raise exception 'CASO 5: salió un mail null en la lista, %', v_emails;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: mail en blanco ('') tampoco sirve como destinatario, aunque
--         no sea null.
-- ------------------------------------------------------------
do $$
declare
  v_con_mail uuid;
  v_blanco   uuid;
  v_tenant   uuid;
  v_emails   text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'conmail6@test.com') returning id into v_con_mail;
  insert into auth.users (id, email) values (gen_random_uuid(), '') returning id into v_blanco;
  insert into public.tenants (slug, name, country)
    values ('notif-blanco', 'Negocio Mail Blanco', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role) values
    (v_con_mail, v_tenant, 'owner'),
    (v_blanco, v_tenant, 'admin');

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_tenant);

  if v_emails is distinct from array['conmail6@test.com'] then
    raise exception 'CASO 6: salió un mail en blanco en la lista, %', v_emails;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: un negocio sin miembros devuelve cero filas, sin romper. La
--         función la llama la app después de confirmar una reserva; no
--         puede tirar un error sólo porque el negocio quedó sin owner/admin.
-- ------------------------------------------------------------
do $$
declare
  v_tenant uuid;
  v_n      int;
begin
  insert into public.tenants (slug, name, country)
    values ('notif-vacio', 'Negocio Sin Miembros', 'AR') returning id into v_tenant;

  select count(*) into v_n from public.tenant_notification_recipients(v_tenant);

  if v_n <> 0 then
    raise exception 'CASO 7: un negocio sin miembros devolvió % filas', v_n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: NADA DE ESTO ESTÁ AL ALCANCE DE `anon`. La función expone
--         mails de auth.users por diseño (security definer); dejarla
--         abierta a una sesión sin loguear sería regalar la lista de
--         contactos de todos los negocios a cualquiera.
--
--         Corre con `set local role`: sin eso el test es superusuario y
--         no prueba un solo permiso — es la falla que este proyecto ya
--         tuvo antes con un test que no seteaba rol.
-- ------------------------------------------------------------
do $$
declare
  v_tenant uuid;
begin
  insert into public.tenants (slug, name, country)
    values ('notif-anon', 'Negocio Anon', 'AR') returning id into v_tenant;

  set local role anon;

  begin
    perform public.tenant_notification_recipients(v_tenant);
    reset role;
    raise exception 'CASO 8: `anon` pudo llamar tenant_notification_recipients.';
  exception
    when insufficient_privilege then reset role;
    when others then reset role; raise;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 9: tampoco alcanza estar logueado. `authenticated` es cualquier
--         dueño o cliente con sesión — ninguno de ellos puede pedir la
--         lista de destinatarios de un negocio, ni siquiera el suyo,
--         porque la ruta de lectura correcta es el panel, no esta función.
-- ------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_tenant uuid;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'dueno9@test.com') returning id into v_owner;
  insert into public.tenants (slug, name, country)
    values ('notif-auth', 'Negocio Authenticated', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_owner, v_tenant, 'owner');

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  begin
    perform public.tenant_notification_recipients(v_tenant);
    reset role;
    raise exception 'CASO 9: `authenticated` (dueño del negocio) pudo llamar la función.';
  exception
    when insufficient_privilege then reset role;
    when others then reset role; raise;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 10: EL POSITIVO. `service_role` sí puede — es el rol real con el
--          que la aplicación la llama desde el servidor, después de
--          confirmar la reserva. Sin este caso, los casos 8 y 9 podrían
--          estar probando una función que nadie puede llamar nunca, lo
--          que rompería el aviso al negocio para todo el mundo.
-- ------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_tenant uuid;
  v_emails text[];
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'dueno10@test.com') returning id into v_owner;
  insert into public.tenants (slug, name, country)
    values ('notif-service', 'Negocio Service Role', 'AR') returning id into v_tenant;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_owner, v_tenant, 'owner');

  set local role service_role;

  select array_agg(email order by email) into v_emails
    from public.tenant_notification_recipients(v_tenant);

  reset role;

  if v_emails is distinct from array['dueno10@test.com'] then
    raise exception
      'CASO 10: service_role no pudo leer la lista (salió %). El aviso al negocio quedaría roto.',
      v_emails;
  end if;
end $$;

rollback;
