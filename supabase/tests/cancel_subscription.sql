-- ============================================================
-- Test SQL para 20260904120001_cancel_subscription.sql
--
-- Misma convención que `trial_expiry.sql`: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus datos, todo en una
-- transacción con ROLLBACK.
--
-- Lo que este archivo defiende, que es lo que un test feliz no ve:
--
-- 1. QUE LA BAJA NO CORTE EL SERVICIO. El caso 3 es la razón de existir del
--    cambio entero: dar de baja el 5 habiendo pagado hasta el 30 tiene que
--    dejar reservando. Una implementación que sólo escriba `canceled` y no
--    toque `tenant_takes_bookings()` pasa el caso 2 y REVIENTA acá.
--
-- 2. QUE SÍ CORTE CUANDO EL PERÍODO TERMINA. El caso 4 es el espejo: sin él,
--    una función que devolviera `true` para cualquier `canceled` pasaría el 3
--    y regalaría el producto para siempre.
--
-- 3. QUE LA BAJA NO SE ROBE LO PAGADO. Los casos 5 y 6 fallan si alguien
--    "simplifica" moviendo `current_period_end` a `now()` o bajando
--    `tenants.plan` — dos formas de hacer inmediata una baja que se decidió
--    diferida, y las dos pasarían el caso 2 sin chistar.
--
-- 4. QUE NO SE HAYA ROTO LO ANTERIOR. `tenant_takes_bookings()` se reescribe
--    entera, así que los casos 9 a 12 revalidan las reglas de
--    20260903120001. Sin eso, esta migración puede resucitar el agujero de la
--    prueba que no vencía nunca y todos los tests nuevos seguirían verdes.
--
-- 5. QUE EL DUEÑO NO SE PUEDA DAR DE BAJA SOLO CONTRA POSTGREST. El caso 13
--    corre con `set local role`. Un test sin eso corre como superusuario y no
--    prueba un solo permiso.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cancel_subscription.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Andamio: un negocio que puede reservar por todos lados menos por el plan.
--
-- Copiado de `trial_expiry.sql` por la misma razón que allá: timezone UTC,
-- disponibilidad los siete días y la hora anclada a las 10 del día, para que
-- el archivo no dependa del día de la semana ni de la hora en que se corra.
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
    values ('Baja Suscripcion', 'baja-suscripcion-test', 'pro', 'AR', 'UTC')
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
      values (v_staff, v_day, '08:00', '20:00');
  end loop;

  insert into t_ids values (
    v_tenant, v_service, v_staff, 'baja-suscripcion-test',
    date_trunc('day', now() + interval '7 days') + interval '10 hours'
  );
end $$;

-- ------------------------------------------------------------
-- Deja UNA suscripción en el estado pedido.
--
-- `p_period_end` es el parámetro que importa en este archivo: es "hasta cuándo
-- está pago", y toda la diferencia entre el caso 3 y el caso 4 es su signo.
-- ------------------------------------------------------------
create or replace function pg_temp.set_subscription(
  p_status      text,
  p_period_end  interval,
  p_trial_ends  interval default null
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
    v.tenant_id, 'pro', p_status::public.subscription_status,
    -- Arranca bien atrás para que `current_period_end` pueda ser pasado sin
    -- violar el check `current_period_end > current_period_start`.
    now() - interval '60 days',
    now() + p_period_end,
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

  -- Se limpia la agenda antes de cada intento: todos los casos piden LA MISMA
  -- franja, y sin esto un caso le ocuparía el cupo al siguiente, que fallaría
  -- por solape y no por el plan. Mismo cuidado que en `trial_expiry.sql`.
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

create or replace function pg_temp.cancel() returns text language plpgsql as $$
declare
  v record;
begin
  select * into v from t_ids;
  return public.cancel_subscription(v.tenant_id);
end $$;

-- ------------------------------------------------------------
-- Caso 1: dar de baja una suscripción activa devuelve 'canceled'.
-- ------------------------------------------------------------
do $$
declare
  v_result text;
begin
  perform pg_temp.set_subscription('active', interval '25 days');

  v_result := pg_temp.cancel();

  if v_result <> 'canceled' then
    raise exception 'CASO 1: esperaba canceled y devolvió %', v_result;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: y la fila quedó efectivamente en `canceled`.
--
-- Va aparte del caso 1 a propósito: una función que devuelva el texto correcto
-- sin escribir nada pasa aquél y falla éste.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_status text;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('active', interval '25 days');
  perform pg_temp.cancel();

  select status into v_status
    from public.subscriptions where tenant_id = v.tenant_id;

  if v_status <> 'canceled' then
    raise exception 'CASO 2: la fila quedó en % y no en canceled', v_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: EL CASO QUE DEFINE EL CAMBIO.
--
-- Se dio de baja pero pagó hasta dentro de 25 días. Tiene que seguir tomando
-- turnos. Antes de esta migración `tenant_takes_bookings()` congelaba a
-- cualquier `canceled` en el acto, así que este caso es exactamente el que
-- falla si alguien revierte la función a la versión de 20260903120001.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('active', interval '25 days');
  perform pg_temp.cancel();

  if not pg_temp.books_ok('Baja con periodo vigente') then
    raise exception
      'CASO 3: congeló una baja con el período PAGO todavía corriendo. '
      'La baja corta el cobro, no el servicio.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: el espejo del 3. Vencido el período, se congela.
--
-- Sin este caso, `tenant_takes_bookings()` podría devolver true para
-- cualquier `canceled` —regalando el producto para siempre— y el caso 3
-- seguiría verde.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('canceled', interval '-1 day');

  if pg_temp.books_ok('Baja con periodo vencido') then
    raise exception
      'CASO 4: reservó con la baja Y el período VENCIDO. '
      '¿La función acepta cualquier canceled sin mirar la fecha?';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: la baja NO mueve `current_period_end`.
--
-- Mover esa fecha a `now()` es la forma más natural de "simplificar" esto, y
-- convierte la baja diferida en inmediata sin que ningún otro test proteste:
-- el caso 3 también se caería, pero este mensaje dice POR QUÉ.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_before timestamptz;
  v_after  timestamptz;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('active', interval '25 days');

  select current_period_end into v_before
    from public.subscriptions where tenant_id = v.tenant_id;

  perform pg_temp.cancel();

  select current_period_end into v_after
    from public.subscriptions where tenant_id = v.tenant_id;

  if v_after is distinct from v_before then
    raise exception
      'CASO 5: la baja movió current_period_end de % a %. Eso le saca al dueño '
      'el tiempo que pagó.', v_before, v_after;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: la baja NO toca `tenants.plan`.
--
-- Bajar el plan acá le sacaría el techo de profesionales y de turnos que
-- todavía tiene pago. Se degrada solo cuando el período vence, porque a partir
-- de ahí no entra trabajo nuevo.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_plan text;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('active', interval '25 days');
  perform pg_temp.cancel();

  select plan into v_plan from public.tenants where id = v.tenant_id;

  if v_plan <> 'pro' then
    raise exception 'CASO 6: la baja cambió tenants.plan a %', v_plan;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: darse de baja dos veces no es un error.
--
-- Pasa de verdad: el botón se aprieta dos veces, o el webhook
-- `preapproval.cancelled` llega antes de que termine nuestra escritura. Quien
-- llama necesita poder tratarlo como éxito.
-- ------------------------------------------------------------
do $$
declare
  v_result text;
begin
  perform pg_temp.set_subscription('active', interval '25 days');
  perform pg_temp.cancel();

  v_result := pg_temp.cancel();

  if v_result <> 'already_canceled' then
    raise exception 'CASO 7: la segunda baja devolvió % y no already_canceled', v_result;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: sin suscripción, lo dice. No inventa una ni miente éxito.
-- ------------------------------------------------------------
do $$
declare
  v_result text;
begin
  perform pg_temp.set_subscription(null, interval '0 days');

  v_result := pg_temp.cancel();

  if v_result <> 'no_subscription' then
    raise exception 'CASO 8: sin suscripción devolvió % y no no_subscription', v_result;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: darse de baja DURANTE la prueba deja terminar la prueba.
--
-- No hay un `or` aparte para esto y no hace falta: `create_business` abre la
-- fila con `current_period_end = trial_ends_at`, así que la prueba ES el
-- período. Este caso fija esa equivalencia — si algún día el registro cambia y
-- las dos fechas se separan, acá se entera.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('trialing', interval '9 days', interval '9 days');
  perform pg_temp.cancel();

  if not pg_temp.books_ok('Baja durante la prueba') then
    raise exception
      'CASO 9: cortó la prueba al darse de baja. El período todavía corría.';
  end if;
end $$;

-- ------------------------------------------------------------
-- REGRESIÓN de 20260903120001. `tenant_takes_bookings()` se reescribió entera,
-- así que sus reglas viejas se revalidan acá: sin esto, esta migración puede
-- resucitar el agujero de la prueba que no vencía nunca sin romper nada nuevo.
-- ------------------------------------------------------------

-- Caso 10: prueba vigente reserva.
do $$
begin
  perform pg_temp.set_subscription('trialing', interval '7 days', interval '7 days');

  if not pg_temp.books_ok('Prueba vigente') then
    raise exception 'CASO 10: frenó una prueba vigente.';
  end if;
end $$;

-- Caso 11: prueba VENCIDA no reserva, aunque el estado siga en `trialing`.
--
-- El estado se queda en `trialing` para siempre porque nada lo mueve. Este es
-- el agujero original; si vuelve, vuelve acá.
do $$
begin
  perform pg_temp.set_subscription('trialing', interval '-1 day', interval '-1 day');

  if pg_temp.books_ok('Prueba vencida') then
    raise exception
      'CASO 11: reservó con la prueba VENCIDA. Volvió el agujero de 20260903120001.';
  end if;
end $$;

-- Caso 12: `past_due` sigue reservando. El cobro falló pero Mercado Pago
-- reintenta, y cortarle la agenda a un negocio que está atendiendo gente por
-- una tarjeta vencida es justo lo que no queremos.
do $$
begin
  perform pg_temp.set_subscription('past_due', interval '25 days');

  if not pg_temp.books_ok('Past due') then
    raise exception 'CASO 12: congeló un past_due, que está en gracia.';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 13: EL DUEÑO NO SE DA DE BAJA SOLO CONTRA POSTGREST.
--
-- `cancel_subscription` es `security definer` y escribe una tabla que no tiene
-- policy de UPDATE para nadie. Si quedara grantada a `authenticated`, cualquier
-- dueño logueado podría llamarla con el `tenant_id` de OTRO negocio y darlo de
-- baja — la función no mira quién llama, mira el parámetro.
--
-- Corre con `set local role`: sin eso el test es superusuario y no prueba un
-- solo permiso. Es la misma lección que dejó el caso 13 de `trial_expiry.sql`.
-- ------------------------------------------------------------
do $$
declare
  v record;
begin
  select * into v from t_ids;

  set local role authenticated;

  begin
    perform public.cancel_subscription(v.tenant_id);
    reset role;
    raise exception
      'CASO 13: `authenticated` pudo ejecutar cancel_subscription. '
      'Cualquier dueño da de baja el negocio de otro.';
  exception
    when insufficient_privilege then
      reset role;
    when others then
      reset role;
      raise;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 14: la vista pública refleja la baja con período vigente.
--
-- Es la superficie que ve el visitante. `create_booking` y `public_tenants`
-- tienen que dar la MISMA respuesta, o la página muestra el formulario y la
-- base lo rechaza al enviar.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_takes boolean;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('active', interval '25 days');
  perform pg_temp.cancel();

  select takes_bookings into v_takes
    from public.public_tenants where slug = v.slug;

  if v_takes is not true then
    raise exception
      'CASO 14: la vista dice % para una baja con período vigente, '
      'pero create_booking la deja reservar.', v_takes;
  end if;
end $$;

rollback;
