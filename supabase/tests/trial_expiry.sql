-- ============================================================
-- Test SQL para 20260903120001_trial_expiry_blocks_new_bookings.sql
--
-- Misma convención que `count_period_bookings.sql`: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus datos, todo en una
-- transacción con ROLLBACK.
--
-- Lo que más se cuida acá son DOS cosas que un test feliz no ve:
--
-- 1. Que el freno mire la FECHA y no la etiqueta. Una prueba vencida se queda
--    en `trialing` para siempre —nada la mueve—, así que un guard escrito como
--    `status <> 'trialing'` pasaría todos los casos donde la prueba está
--    vigente y dejaría el agujero intacto. El caso 2 existe para que esa
--    versión ROMPA.
--
-- 2. Que NO se haya roto lo que se decidió mantener. Un negocio vencido tiene
--    que poder seguir reprogramando y cerrando los turnos que ya tiene: el
--    caso 9 falla si alguien "endurece" el freno metiéndolo en
--    `reschedule_booking()`.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/trial_expiry.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Andamio: un negocio que puede reservar por todos lados menos por el plan.
--
-- Timezone en UTC y disponibilidad en los SIETE días a propósito: la franja de
-- prueba se calcula sobre `now()`, así que su día de la semana cambia según
-- cuándo corra el test. Dejar un solo weekday cargado haría que este archivo
-- pasara de lunes a jueves y fallara los viernes.
--
-- La hora se ancla con `date_trunc('day', ...) + 10 horas` por lo mismo: con
-- `now() + interval '7 days'` pelado, correr el test 23:50 daría un turno que
-- termina al día siguiente y se cae contra `end_time`, sin que nada del plan
-- tenga que ver.
-- ------------------------------------------------------------
create temporary table t_ids (
  tenant_id  uuid,
  service_id uuid,
  staff_id   uuid,
  slug       text,
  starts_at  timestamptz
) on commit drop;

do $$
declare
  v_tenant  uuid;
  v_service uuid;
  v_staff   uuid;
  v_day     smallint;
begin
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Prueba Vencida', 'prueba-vencida-test', 'basico', 'AR', 'UTC')
    returning id into v_tenant;

  insert into public.services (tenant_id, name, duration_min, price_cents, currency)
    values (v_tenant, 'Corte', 30, 1000, 'ARS')
    returning id into v_service;

  insert into public.staff (tenant_id, name)
    values (v_tenant, 'Ana')
    returning id into v_staff;

  insert into public.staff_services (staff_id, service_id)
    values (v_staff, v_service);

  for v_day in 0..6 loop
    insert into public.staff_availability (staff_id, weekday, start_time, end_time)
      values (v_staff, v_day, '00:00', '23:59');
  end loop;

  insert into t_ids values (
    v_tenant, v_service, v_staff, 'prueba-vencida-test',
    date_trunc('day', now() + interval '7 days') + interval '10 hours'
  );
end $$;

-- ------------------------------------------------------------
-- Helpers.
--
-- `set_subscription` borra antes de insertar porque el índice único parcial
-- `subscriptions_one_live_per_tenant` no deja dos vivas por negocio: sin el
-- delete, el segundo caso reventaría por el índice y no por lo que se quiere
-- probar.
--
-- `books_ok` devuelve si la reserva ENTRA, distinguiendo el rechazo del plan
-- de cualquier otro: si el andamio se rompiera —un servicio inactivo, una
-- franja mal calculada— sin este `when others then raise` el test contaría ese
-- fallo como "el freno funcionó" y pasaría en verde por el motivo equivocado.
-- ------------------------------------------------------------
create or replace function pg_temp.set_subscription(
  p_status text,
  p_trial_ends interval,
  -- Hasta cuándo está PAGO. Por defecto futuro, que es el caso de casi todos
  -- los casos de este archivo: lo que se está probando acá es la prueba, no el
  -- período. Lo mueve sólo el caso 6, donde el período ES la variable.
  p_period_end interval default interval '30 days'
) returns void language plpgsql as $$
declare
  v record;
begin
  select * into v from t_ids;

  delete from public.subscriptions where tenant_id = v.tenant_id;

  if p_status is null then
    return;
  end if;

  insert into public.subscriptions (
    tenant_id, plan, status,
    current_period_start, current_period_end, trial_ends_at, price_usd_cents
  ) values (
    v.tenant_id, 'basico', p_status::public.subscription_status,
    -- Arranca bien atrás para que `p_period_end` pueda ser pasado sin violar
    -- el check `current_period_end > current_period_start`.
    now() - interval '60 days', now() + p_period_end,
    case when p_trial_ends is null then null else now() + p_trial_ends end,
    0
  );
end $$;

create or replace function pg_temp.books_ok(p_name text)
returns boolean language plpgsql as $$
declare
  v record;
begin
  select * into v from t_ids;

  -- Se limpia la agenda antes de cada intento. Todos los casos piden LA MISMA
  -- franja a propósito —cambiar el horario entre casos metería la
  -- disponibilidad como segunda variable—, y sin este delete el caso 1 le
  -- ocuparía el cupo al 4, que fallaría por "no quedan lugares" y no por el
  -- plan. El solape ya tiene sus propios tests; acá estorba.
  delete from public.bookings where tenant_id = v.tenant_id;

  perform public.create_booking(
    v.slug, v.staff_id, v.service_id, v.starts_at, p_name, null, '1122334455'
  );
  return true;
exception
  when sqlstate 'P0001' then
    if sqlerrm ilike '%sin plan activo%' then
      return false;
    end if;
    raise exception 'Rechazo INESPERADO (no es el del plan): %', sqlerrm;
end $$;

-- ------------------------------------------------------------
-- Caso 1: con la prueba vigente se reserva.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('trialing', interval '7 days');

  if not pg_temp.books_ok('Vigente') then
    raise exception 'CASO 1: frenó una prueba que todavía no venció.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: EL CASO QUE DEFINE EL CAMBIO.
--
-- La prueba venció ayer y el estado SIGUE siendo `trialing`, porque nada lo
-- mueve: no hay cron, no hay trigger, y el webhook sólo se despierta si
-- alguien paga. Ese es el estado real de todo negocio que se registró y no
-- pagó. Si el freno mirara la etiqueta en vez de la fecha, acá reservaría.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('trialing', interval '-1 day');

  if pg_temp.books_ok('Vencido') then
    raise exception
      'CASO 2: reservó con la prueba VENCIDA. ¿El guard mira el status y no trial_ends_at?';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: `trialing` sin fecha de vencimiento no habilita nada.
--
-- `null > now()` es null, no true. Si alguien reescribiera la condición con un
-- `coalesce(trial_ends_at, 'infinity')` "por las dudas", este caso lo agarra.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('trialing', null);

  if pg_temp.books_ok('Sin fecha') then
    raise exception 'CASO 3: una prueba sin trial_ends_at habilitó la reserva.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: una suscripción paga reserva, con la fecha de prueba ya vencida.
--
-- La fecha vencida es a propósito: es el estado normal de cualquiera que pagó
-- después de probar. Un guard que mirara sólo `trial_ends_at` sin mirar el
-- estado le cortaría la agenda justo al único que está pagando.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('active', interval '-30 days');

  if not pg_temp.books_ok('Pagando') then
    raise exception 'CASO 4: frenó a un negocio con la suscripción ACTIVA.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: `past_due` sigue reservando durante la gracia.
--
-- El cobro falló pero Mercado Pago lo sigue reintentando. Cortarle la agenda a
-- un negocio que está atendiendo gente por una tarjeta vencida es exactamente
-- lo que no queremos.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('past_due', null);

  if not pg_temp.books_ok('Atrasado') then
    raise exception 'CASO 5: cortó la agenda por un cobro atrasado, sin gracia.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: una cancelada CON EL PERÍODO YA VENCIDO no reserva.
--
-- Ojo con lo que este caso dice y lo que NO dice, porque cambió en
-- 20260904120001. Una baja YA NO congela por el estado: congela cuando se le
-- termina lo pagado. La baja corta el cobro, no el servicio, así que quien
-- pagó hasta el 30 y se dio de baja el 5 sigue reservando hasta el 30.
--
-- Por eso acá el período se manda VENCIDO, y por eso el `trial_ends_at` futuro
-- sigue siendo parte del caso: prueba que una fecha de prueba en el futuro no
-- resucita una suscripción muerta cuyo período ya pasó.
--
-- La mitad positiva —baja con período vigente que SÍ reserva— vive en
-- `cancel_subscription.sql`, caso 3, que es donde está su migración.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('canceled', interval '7 days', interval '-1 day');

  if pg_temp.books_ok('Cancelado') then
    raise exception
      'CASO 6: una cancelada con el período VENCIDO habilitó la reserva.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: sin ninguna suscripción no se reserva.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription(null, null);

  if pg_temp.books_ok('Sin suscripción') then
    raise exception 'CASO 7: reservó un negocio SIN suscripción.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: el freno contesta ANTES que las validaciones de la franja.
--
-- Se pide un servicio que no existe en un negocio vencido. Las dos cosas están
-- mal; la que tiene que contestar es el plan. Si el chequeo estuviera más
-- abajo, a un negocio vencido se le diría "servicio no disponible" y lo
-- mandaría a probar otro servicio, otro profesional y otro horario para
-- siempre, sin enterarse nunca de lo que realmente pasa.
-- ------------------------------------------------------------
do $$
declare
  v record;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('trialing', interval '-1 day');

  begin
    perform public.create_booking(
      v.slug, v.staff_id, gen_random_uuid(), v.starts_at, 'Orden', null, '1122334455'
    );
    raise exception 'CASO 8: no rechazó nada.';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not ilike '%sin plan activo%' then
        raise exception
          'CASO 8: contestó "%" en vez del rechazo del plan. ¿El guard quedó abajo de las otras validaciones?',
          sqlerrm;
      end if;
    when sqlstate 'P0002' then
      raise exception
        'CASO 8: contestó "%" en vez del rechazo del plan. ¿El guard quedó abajo de las otras validaciones?',
        sqlerrm;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 9: LO QUE NO SE ROMPE.
--
-- Con la prueba VENCIDA, el negocio tiene que poder seguir reprogramando lo
-- que ya tenía. Un turno ya tomado es un compromiso con el cliente del
-- negocio; romperlo por una deuda del negocio castiga a quien no debe nada.
-- Este caso falla si alguien mete el freno también en `reschedule_booking()`.
-- ------------------------------------------------------------
do $$
declare
  v          record;
  v_booking  uuid;
  v_user     uuid;
begin
  select * into v from t_ids;

  -- `reschedule_booking()` aísla por `auth_tenant_ids()`, así que sin sesión
  -- contesta "Turno inexistente" y este caso pasaría a probar la RLS en vez
  -- del freno. Hace falta un dueño de verdad: usuario, membresía y el claim.
  -- Mismo andamio que `tenants_column_grants.sql`.
  insert into auth.users (email) values ('vencido@test.com') returning id into v_user;
  insert into public.memberships (user_id, tenant_id, role)
    values (v_user, v.tenant_id, 'owner');
  perform set_config('request.jwt.claim.sub', v_user::text, true);

  -- El turno se toma mientras la prueba todavía corre...
  perform pg_temp.set_subscription('trialing', interval '7 days');
  delete from public.bookings where tenant_id = v.tenant_id;
  select id into v_booking from public.create_booking(
    v.slug, v.staff_id, v.service_id, v.starts_at, 'Ya reservado', null, '1122334455'
  );

  -- ...y recién después se vence.
  perform pg_temp.set_subscription('trialing', interval '-1 day');

  -- El handler abarca SÓLO la reprogramación. Envolviendo también el alta de
  -- arriba, un andamio roto habría reportado "no se pudo reprogramar" y
  -- mandado a buscar el bug adentro de `reschedule_booking()`, que no lo tiene.
  begin
    perform public.reschedule_booking(v_booking, v.starts_at + interval '1 day');
  exception
    when others then
      raise exception
        'CASO 9: no se pudo reprogramar un turno ya tomado con la prueba vencida (%). La agenda existente NO se toca.',
        sqlerrm;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 10: la página pública también frena.
--
-- `create_public_booking()` delega en `create_booking()`, así que hereda el
-- freno sin tener su propia copia. Este caso existe para que esa delegación
-- no se pierda en silencio el día que alguien duplique la lógica.
-- ------------------------------------------------------------
do $$
declare
  v record;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('trialing', interval '-1 day');

  begin
    perform public.create_public_booking(
      v.slug, v.staff_id, v.service_id, v.starts_at, 'Anónimo',
      'hash-de-prueba', null, '1122334455'
    );
    raise exception 'CASO 10: la página pública reservó con la prueba vencida.';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not ilike '%sin plan activo%' then
        raise exception 'CASO 10: rechazó por "%" y no por el plan.', sqlerrm;
      end if;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 11: la vista pública dice la verdad, en los dos sentidos.
--
-- Es lo que le evita al visitante llenar el formulario entero para que el
-- submit le conteste que no. Se prueban los DOS valores contra el mismo
-- negocio: una vista que devolviera `true` fijo pasaría con sólo mirar el
-- caso feliz.
-- ------------------------------------------------------------
do $$
declare
  v      record;
  v_flag boolean;
begin
  select * into v from t_ids;

  perform pg_temp.set_subscription('trialing', interval '7 days');
  select takes_bookings into v_flag
    from public.public_tenants where id = v.tenant_id;
  if v_flag is not true then
    raise exception 'CASO 11: la vista dice % con la prueba vigente.', v_flag;
  end if;

  perform pg_temp.set_subscription('trialing', interval '-1 day');
  select takes_bookings into v_flag
    from public.public_tenants where id = v.tenant_id;
  if v_flag is not false then
    raise exception 'CASO 11: la vista dice % con la prueba vencida.', v_flag;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 12: la vista NO filtró el plan ni el estado.
--
-- `public_tenants` es anónima y su encabezado declara qué puede exponer: nada
-- de plan ni de país. Se agregó una columna; esto verifica que se agregó UNA.
-- Que el negocio esté en prueba, atrasado o cancelado no es asunto de quien
-- entra a sacar un turno.
-- ------------------------------------------------------------
do $$
declare
  v_extra text;
begin
  select string_agg(column_name, ', ') into v_extra
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'public_tenants'
    and column_name not in (
      'id', 'slug', 'name', 'timezone', 'brand_color', 'logo_url', 'takes_bookings'
    );

  if v_extra is not null then
    raise exception 'CASO 12: la vista pública expone de más: %.', v_extra;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 13: LA VISTA SE LEE CON LOS ROLES DE PRODUCCIÓN.
--
-- Todo lo de arriba corre como el dueño de los objetos, que es justo el rol
-- para el que un `revoke` es inerte. La página pública NO se lee con ese rol:
-- PostgREST entra como `anon` o como `authenticated`.
--
-- La primera versión de esta migración les revocaba EXECUTE y confiaba en que
-- `security_invoker = false` alcanzaba. No alcanza: eso sustituye al dueño
-- sólo en el chequeo sobre las RELACIONES, y el EXECUTE de la función se
-- sigue chequeando contra el rol que consulta. Daba
-- `permission denied for function tenant_takes_bookings` en cada visita, o
-- sea 404 en TODA página pública.
-- ------------------------------------------------------------
do $$
declare
  v_rol  text;
  v_flag boolean;
begin
  perform pg_temp.set_subscription('trialing', interval '7 days');

  foreach v_rol in array array['anon', 'authenticated'] loop
    begin
      -- `set local`: un fallo entre medio dejaría la sesión en ese rol y los
      -- errores del resto no tendrían nada que ver con la causa.
      execute format('set local role %I', v_rol);
      select takes_bookings into v_flag
        from public.public_tenants where slug = 'prueba-vencida-test';
      reset role;
    exception
      when insufficient_privilege then
        reset role;
        raise exception
          'CASO 13: % no puede leer la vista (%). Toda página pública da 404. ¿Falta el grant de execute sobre tenant_takes_bookings?',
          v_rol, sqlerrm;
    end;

    if v_flag is not true then
      raise exception 'CASO 13: % leyó % en vez de true.', v_rol, v_flag;
    end if;
  end loop;
end $$;

rollback;
