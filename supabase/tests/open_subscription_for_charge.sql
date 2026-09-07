-- ============================================================
-- Test SQL para 20260907120001 + 20260907120002 — el re-alta.
--
-- Misma convención que `cancel_subscription.sql`: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus datos, todo en una
-- transacción con ROLLBACK.
--
-- Lo que este archivo defiende, que es lo que un test feliz no ve:
--
-- 1. QUE EL QUE VUELVE NO RECIBA OTRA PRUEBA GRATIS. El caso 3 es la regla de
--    producto entera. Una implementación que abra la fila en `trialing` —que
--    es el default de la columna, o sea el camino de menor resistencia— pasa
--    los casos 1 y 2 y REGALA catorce días acá.
--
-- 2. QUE LA FILA NUEVA NO HABILITE NADA. El caso 4 es el espejo del anterior:
--    abrirla en `active` o en `past_due` también esquiva la prueba gratis, y
--    entrega el producto antes de que entre un peso.
--
-- 3. QUE NO SE PISE LA HISTORIA. El caso 5 falla si alguien "simplifica"
--    reviviendo la fila cancelada con un UPDATE. Pasaría los casos 1 a 4 sin
--    chistar y dejaría al negocio sin registro de que se fue — que es
--    justamente el hecho sobre el que esta función decide.
--
-- 4. QUE DOS CLICS NO ABRAN DOS COBROS. Los casos 6 y 10 son plata: cada fila
--    `incomplete` de más se lleva su propio preapproval, y los dos debitan
--    todos los meses.
--
-- 5. QUE NO SE HAYA ROTO EL CAMINO DE SIEMPRE. Los casos 7 y 8 revalidan lo
--    que ya andaba —contratar durante la prueba, cambiar de plan estando al
--    día—. Sin ellos, una función que abra una fila nueva SIEMPRE pasa todo lo
--    anterior y le abre un segundo cobro a quien ya está pagando.
--
-- 6. QUE EL RE-ALTA TERMINE. Los casos 11 a 13 recorren la cadena completa
--    hasta el cobro: abrir, estampar el checkout, aplicar el pago, volver a
--    tomar turnos. Sin ellos esto prueba que se puede EMPEZAR a volver, que no
--    es lo que el dueño compró.
--
-- 7. QUE EL DUEÑO NO SE ABRA UNA SUSCRIPCIÓN SOLO. El caso 14 corre con
--    `set local role`. Un test sin eso corre como superusuario y no prueba un
--    solo permiso.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/open_subscription_for_charge.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Andamio: un negocio y nada más.
--
-- A diferencia de `cancel_subscription.sql` acá no hace falta servicio,
-- profesional ni disponibilidad: lo que se mide es `tenant_takes_bookings()`,
-- que mira la suscripción y nada más. Armar una agenda entera para eso pondría
-- entre el test y la regla cuatro tablas que pueden fallar por su cuenta.
-- ------------------------------------------------------------
create temporary table t_ids (tenant_id uuid, slug text) on commit drop;

do $$
declare
  v_tenant uuid;
begin
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Re Alta', 're-alta-test', 'pro', 'AR', 'UTC')
    returning id into v_tenant;

  insert into t_ids values (v_tenant, 're-alta-test');
end $$;

-- ------------------------------------------------------------
-- Deja al negocio con UNA suscripción en el estado pedido, o con ninguna.
--
-- `p_period_end` arranca el período bien atrás para que pueda ser pasado sin
-- violar el check `current_period_end > current_period_start`. Copiado de
-- `cancel_subscription.sql` por la misma razón que allá.
-- ------------------------------------------------------------
create or replace function pg_temp.set_subscription(
  p_status     text,
  p_period_end interval default interval '25 days',
  p_trial_ends interval default null
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
    now() - interval '60 days',
    now() + p_period_end,
    case when p_trial_ends is null then null else now() + p_trial_ends end,
    0
  );
end $$;

create or replace function pg_temp.open(p_plan text default 'pro')
returns uuid language plpgsql as $$
declare
  v record;
begin
  select * into v from t_ids;
  return public.open_subscription_for_charge(v.tenant_id, p_plan::public.plan_tier);
end $$;

create or replace function pg_temp.takes_bookings() returns boolean
language plpgsql as $$
declare
  v record;
begin
  select * into v from t_ids;
  return public.tenant_takes_bookings(v.tenant_id);
end $$;

-- ------------------------------------------------------------
-- Caso 1: un negocio dado de baja recibe una fila NUEVA.
--
-- El id tiene que ser distinto del de la cancelada. Igual significaría que se
-- revivió la vieja, que es lo que el caso 5 persigue desde el otro lado.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_old uuid;
  v_new uuid;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled');

  select id into v_old from public.subscriptions where tenant_id = v.tenant_id;

  v_new := pg_temp.open();

  if v_new is null then
    raise exception 'CASO 1: no abrió ninguna suscripción para un negocio dado de baja';
  end if;

  if v_new is not distinct from v_old then
    raise exception 'CASO 1: revivió la fila cancelada en vez de abrir una nueva';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: y esa fila nueva quedó en `incomplete`.
--
-- Va aparte del caso 1 a propósito: una función que inserte en cualquier
-- estado devuelve un id nuevo igual y pasa aquél.
-- ------------------------------------------------------------
do $$
declare
  v_new    uuid;
  v_status text;
begin
  perform pg_temp.set_subscription('canceled');
  v_new := pg_temp.open();

  select status into v_status from public.subscriptions where id = v_new;

  if v_status <> 'incomplete' then
    raise exception 'CASO 2: la fila nueva quedó en % y no en incomplete', v_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: EL QUE VUELVE NO RECIBE OTRA PRUEBA GRATIS.
--
-- Es la regla de producto de este cambio. Se chequean las DOS cosas que la
-- harían falsa —el estado y la fecha— porque `isInTrial()` exige las dos, y
-- una implementación que ponga `trial_ends_at` sin poner `trialing` deja una
-- fecha suelta esperando a que alguien la mire.
-- ------------------------------------------------------------
do $$
declare
  v_new  uuid;
  v_row  public.subscriptions;
begin
  perform pg_temp.set_subscription('canceled');
  v_new := pg_temp.open();

  select * into v_row from public.subscriptions where id = v_new;

  if v_row.status = 'trialing' then
    raise exception 'CASO 3: le abrió una SEGUNDA prueba gratis al que ya se fue';
  end if;

  if v_row.trial_ends_at is not null then
    raise exception
      'CASO 3: dejó trial_ends_at en % sobre una fila de re-alta', v_row.trial_ends_at;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: la fila nueva NO habilita turnos.
--
-- El re-alta abre la puerta al COBRO, no al servicio. Quien activa es el
-- webhook cuando el pago entra. Una fila abierta en `active` o en `past_due`
-- pasa los casos 1 a 3 y entrega el producto gratis.
-- ------------------------------------------------------------
do $$
begin
  perform pg_temp.set_subscription('canceled', interval '-3 days');
  perform pg_temp.open();

  if pg_temp.takes_bookings() then
    raise exception
      'CASO 4: el negocio toma turnos con la sola fila de re-alta, sin haber pagado';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: la baja sigue estando. La historia no se pisa.
--
-- Tienen que quedar DOS filas. Es lo que el índice único parcial de
-- 20260817120001 previó desde el día uno —"un negocio que se da de baja y
-- vuelve deja dos filas"— y lo que hace auditable que este negocio se fue.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_total    int;
  v_canceled int;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled');
  perform pg_temp.open();

  select count(*) into v_total
    from public.subscriptions where tenant_id = v.tenant_id;
  select count(*) into v_canceled
    from public.subscriptions where tenant_id = v.tenant_id and status = 'canceled';

  if v_total <> 2 then
    raise exception 'CASO 5: quedaron % filas y esperaba 2', v_total;
  end if;

  if v_canceled <> 1 then
    raise exception 'CASO 5: se perdió el registro de la baja';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: DOS CLICS NO ABREN DOS COBROS.
--
-- La segunda llamada tiene que devolver el MISMO id. Cada fila `incomplete` de
-- más se lleva su propio preapproval en Mercado Pago, y los dos debitan todos
-- los meses hasta que alguien los encuentre a mano.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_first  uuid;
  v_second uuid;
  v_total  int;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled');

  v_first  := pg_temp.open();
  v_second := pg_temp.open();

  -- `is distinct from` y no `<>`: si la función devuelve null, `null <> uuid`
  -- da NULL y el `if` no dispara — la comparación ingenua deja pasar justo el
  -- fallo que este caso persigue.
  if v_first is distinct from v_second then
    raise exception
      'CASO 6: dos llamadas abrieron suscripciones distintas (% y %)', v_first, v_second;
  end if;

  select count(*) into v_total
    from public.subscriptions where tenant_id = v.tenant_id and status = 'incomplete';

  if v_total <> 1 then
    raise exception 'CASO 6: quedaron % filas incomplete', v_total;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: con una suscripción VIVA devuelve esa, y no escribe nada.
--
-- Es el camino de siempre: cambiar de plan estando al día. Una función que
-- abra una fila nueva siempre pasa todo lo anterior y le abre un SEGUNDO cobro
-- a quien ya está pagando — el peor desenlace de este archivo.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_live  uuid;
  v_got   uuid;
  v_total int;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('active');

  select id into v_live from public.subscriptions where tenant_id = v.tenant_id;

  v_got := pg_temp.open();

  -- `is distinct from`, por lo mismo que el caso 6: una función que no mire
  -- lo ya cobrable devuelve null acá, y `null <> uuid` no dispara un `<>`.
  if v_got is distinct from v_live then
    raise exception 'CASO 7: devolvió % y la viva era %', v_got, v_live;
  end if;

  select count(*) into v_total
    from public.subscriptions where tenant_id = v.tenant_id;

  if v_total <> 1 then
    raise exception 'CASO 7: escribió una fila de más estando el negocio al día';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: durante la prueba también devuelve la fila que ya hay.
--
-- Contratar durante la prueba es como entra la mayoría. `trialing` no está en
-- `PAYING_STATUSES` de la pantalla justamente para que el botón se pueda
-- apretar ahí, y esta función tiene que acompañarlo.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_trial uuid;
  v_got   uuid;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('trialing', interval '10 days', interval '10 days');

  select id into v_trial from public.subscriptions where tenant_id = v.tenant_id;

  v_got := pg_temp.open();

  if v_got is distinct from v_trial then
    raise exception 'CASO 8: no devolvió la fila de la prueba';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: un negocio sin NINGUNA fila devuelve null.
--
-- No se inventa una suscripción. `create_business` abre la fila en la misma
-- transacción que el negocio, así que esto es un estado roto y taparlo acá lo
-- volvería invisible justo en la tabla donde se guarda la plata.
-- ------------------------------------------------------------
do $$
declare
  v_got uuid;
begin
  perform pg_temp.set_subscription(null);

  v_got := pg_temp.open();

  if v_got is not null then
    raise exception 'CASO 9: le inventó la suscripción % a un negocio que no tenía ninguna', v_got;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 10: el índice prohíbe dos `incomplete`, aunque se escriban a mano.
--
-- El caso 6 prueba que la FUNCIÓN no abre dos. Éste prueba que la BASE no deja
-- — que es lo que protege contra dos pestañas del mismo dueño llegando a la
-- vez, donde las dos leen "no hay ninguna" antes de que ninguna escriba.
-- ------------------------------------------------------------
do $$
declare
  v record;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled');
  perform pg_temp.open();

  begin
    insert into public.subscriptions (
      tenant_id, plan, status,
      current_period_start, current_period_end, price_usd_cents
    ) values (
      v.tenant_id, 'pro', 'incomplete',
      now() - interval '1 day', now(), 0
    );
    raise exception 'CASO 10: la base aceptó una SEGUNDA fila incomplete';
  exception
    when unique_violation then
      null;
  end;
end $$;

-- ------------------------------------------------------------
-- Caso 11: `attach_subscription_checkout` acepta la fila del re-alta.
--
-- Es el eslabón que hace que el checkout termine. Esa función filtra por
-- `status <> 'canceled'`, así que `incomplete` pasa sin tocarle una línea —
-- pero eso hay que PROBARLO, no suponerlo: el día que alguien la ajuste a una
-- lista blanca de estados, el re-alta se rompe en silencio y el dueño se queda
-- con un preapproval abierto que nuestra fila no conoce.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_new    uuid;
  v_result boolean;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled');
  v_new := pg_temp.open();

  v_result := public.attach_subscription_checkout(
    v.tenant_id, v_new, 'pro', 3500, 4550000,
    1300, 'dolarapi:bolsa', now(),
    'mercadopago', 'preapproval-re-alta-1'
  );

  if v_result is not true then
    raise exception 'CASO 11: attach_subscription_checkout rechazó la fila del re-alta';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 12: el cobro la activa. `incomplete` → `active`.
--
-- EL CASO QUE PRUEBA QUE EL RE-ALTA TERMINA. `apply_subscription_payment`
-- rechaza `canceled` y no mira ningún otro estado antes de escribir `active`,
-- así que la transición ya existe — igual que arriba, se prueba porque es la
-- que el dueño compró.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_new    uuid;
  v_result text;
  v_status text;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled');
  v_new := pg_temp.open();

  perform public.attach_subscription_checkout(
    v.tenant_id, v_new, 'pro', 3500, 4550000,
    1300, 'dolarapi:bolsa', now(),
    'mercadopago', 'preapproval-re-alta-2'
  );

  v_result := public.apply_subscription_payment(
    'mercadopago', 'evento-re-alta-1', 'preapproval-re-alta-2',
    'authorized_payment', 'payment.created', 'active'
  );

  if v_result <> 'applied' then
    raise exception 'CASO 12: el pago devolvió % sobre la fila del re-alta', v_result;
  end if;

  select status into v_status from public.subscriptions where id = v_new;

  if v_status <> 'active' then
    raise exception 'CASO 12: después del cobro la fila quedó en % y no en active', v_status;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 13: y ahí sí, vuelve a tomar turnos.
--
-- La cadena completa vista desde donde la mira el negocio. Sin este caso el
-- archivo prueba que se puede EMPEZAR a volver, que no es lo que se compró.
-- ------------------------------------------------------------
do $$
declare
  v record;
  v_new uuid;
begin
  select * into v from t_ids;
  perform pg_temp.set_subscription('canceled', interval '-3 days');
  v_new := pg_temp.open();

  perform public.attach_subscription_checkout(
    v.tenant_id, v_new, 'pro', 3500, 4550000,
    1300, 'dolarapi:bolsa', now(),
    'mercadopago', 'preapproval-re-alta-3'
  );

  perform public.apply_subscription_payment(
    'mercadopago', 'evento-re-alta-2', 'preapproval-re-alta-3',
    'authorized_payment', 'payment.created', 'active'
  );

  if not pg_temp.takes_bookings() then
    raise exception 'CASO 13: pagó el re-alta y sigue sin poder tomar turnos';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 14: EL DUEÑO NO SE ABRE UNA SUSCRIPCIÓN SOLO.
--
-- `open_subscription_for_charge` es `security definer` y ESCRIBE en una tabla
-- que no tiene policy de INSERT para nadie. Grantada a `authenticated`,
-- cualquier dueño logueado se abre filas en el negocio de otro — la función no
-- mira quién llama, mira el parámetro.
--
-- Corre con `set local role`: sin eso el test es superusuario y no prueba un
-- solo permiso. Misma lección que el caso 13 de `cancel_subscription.sql`.
-- ------------------------------------------------------------
do $$
declare
  v record;
begin
  select * into v from t_ids;

  set local role authenticated;

  begin
    perform public.open_subscription_for_charge(v.tenant_id, 'pro');
    reset role;
    raise exception
      'CASO 14: `authenticated` pudo ejecutar open_subscription_for_charge. '
      'Cualquier dueño abre suscripciones en el negocio de otro.';
  exception
    when insufficient_privilege then
      reset role;
    when others then
      reset role;
      raise;
  end;
end $$;

rollback;
