-- ============================================================
-- El que se fue puede volver.
--
-- Cierra el hueco que dejó abierto 20260904120001: la baja se construyó
-- entera, el re-alta no existía. Un negocio `canceled` apretaba "Contratar" y
-- recibía "tu negocio no tiene una suscripción activa", que además de no
-- servirle es falso — no tiene una activa justamente porque hizo lo que le
-- ofrecimos hacer.
--
-- LA REGLA DE PRODUCTO QUE ESTA MIGRACIÓN HACE ESTRUCTURAL: el que vuelve NO
-- recibe otra prueba gratis. No hay un `if` que lo chequee ni una fecha que
-- comparar: la fila nueva nace en `incomplete` con `trial_ends_at` en null, y
-- `isInTrial()` exige estado `trialing` Y fecha futura. La regla se cumple
-- porque no hay forma de escribir el estado que la rompería.
-- ============================================================

-- ------------------------------------------------------------
-- UN negocio, UN intento de cobro abierto.
--
-- Hermano del `subscriptions_one_live_per_tenant` de 20260817120001, y hace
-- falta por la misma razón que aquél: sin él, dos clics seguidos en
-- "Contratar" abren dos filas `incomplete`, cada una se lleva su preapproval,
-- y el negocio termina con dos débitos mensuales por el mismo servicio. El
-- picker ya bloquea los tres botones mientras uno está en vuelo, pero eso es
-- una defensa de PANTALLA: la action es alcanzable por POST directo y dos
-- pestañas abiertas no comparten ese estado.
--
-- Es un índice aparte y no `'incomplete'` agregado al de arriba porque las dos
-- cosas que prohíben son distintas y tienen que poder coexistir: mientras el
-- primer cobro no entra, la fila `incomplete` convive con la `canceled` que
-- quedó de historia, y el día que entra pasa a `active` — ahí manda el otro
-- índice. Meterlas en un solo índice diría que un negocio no puede tener a la
-- vez algo vivo y algo pendiente, que es verdad hoy por otro motivo y no es lo
-- que este índice está afirmando.
-- ------------------------------------------------------------
create unique index subscriptions_one_pending_per_tenant
  on public.subscriptions(tenant_id)
  where status = 'incomplete';

-- ------------------------------------------------------------
-- La suscripción a la que atarle un cobro, abriéndola si hace falta.
--
-- Reemplaza el primer paso de `startCheckout`, que hasta hoy era una lectura
-- pura de la fila viva. Es una sola función y no "leer, y si no hay, escribir"
-- del lado de la aplicación PORQUE ES PLATA: entre la lectura y la escritura
-- caben dos pestañas del mismo dueño, y cada una abriría su preapproval. Acá
-- las dos llamadas concurrentes se encuentran en el índice único de arriba y
-- la que pierde se queda con la fila de la que ganó.
--
-- LOS TRES DESENLACES, y por qué el del medio es el único nuevo:
--
--   1. Ya hay una fila cobrable —viva o con un intento pendiente—. Se devuelve
--      esa. Es el camino de siempre: contratar durante la prueba, o cambiar de
--      plan estando al día. Esta función NO escribe nada en ese caso.
--   2. No hay ninguna cobrable pero SÍ una dada de baja: el negocio se fue y
--      está volviendo. Se abre una `incomplete`. Es el re-alta.
--   3. No hay ninguna fila. Devuelve null, y quien llama lo trata como error.
--      No se inventa una suscripción: `create_business` abre la fila en la
--      misma transacción que el negocio y 20260817120002 le dio una a cada
--      negocio que ya existía, así que un negocio sin NINGUNA fila no es un
--      negocio nuevo, es un estado roto. Taparlo acá con un insert lo volvería
--      invisible justo en la tabla donde se guarda la plata.
--
-- POR QUÉ EXIGE UNA `canceled` PARA ABRIR (caso 2 y no "abrir siempre"): sin
-- esa condición, cualquier negocio en un estado que no previmos —una fila
-- borrada a mano, un `incomplete` que alguien limpió— se auto-repararía con
-- una suscripción nueva y nadie se enteraría. El re-alta es para el que se dio
-- de baja, y eso es un hecho que la tabla puede probar.
--
-- LOS DOS VALORES DE RELLENO, que son de relleno y conviene que se lea:
--
--   · El período nace CERRADO (`p_now - 1 día` → `p_now`) y no abierto hacia
--     adelante. La columna es `not null` y el check `subscriptions_period_order`
--     exige `end > start`, así que hay que poner algo; poner algo que ya venció
--     es lo único seguro. Si mañana alguien agrega `incomplete` a
--     `tenant_takes_bookings()` por error, un período vencido no regala nada
--     igual. Lo pisa el primer cobro: `apply_subscription_payment` rota el
--     período recién cuando llega el aviso de un pago de verdad.
--   · `price_usd_cents` en 0 porque el precio todavía no se calculó — sale de
--     la cotización del día, que `startCheckout` pide DESPUÉS de este paso. Lo
--     estampa `attach_subscription_checkout` unos milisegundos más tarde, y
--     hasta entonces nadie lee el precio de una fila `incomplete`.
--
-- `p_plan` se guarda aunque también lo pise `attach_subscription_checkout`: la
-- columna es `not null` y elegir el plan de otro sería peor que guardar el que
-- el dueño acaba de apretar.
--
-- `security definer` y grant sólo a `service_role`, igual que sus dos
-- hermanas: `subscriptions` no tiene policy de INSERT ni de UPDATE para nadie,
-- y ese hueco es la decisión — un dueño que pudiera escribir su propia
-- suscripción se pondría `active` en premium sin pagar. Quien decide que el
-- que pide es el dueño es el server action, con la sesión en la mano.
-- ------------------------------------------------------------
create or replace function public.open_subscription_for_charge(
  p_tenant_id uuid,
  p_plan      public.plan_tier,
  p_now       timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- 1. Lo cobrable ya existente. `incomplete` entra en la lista: si el dueño
  --    volvió del checkout sin pagar y reintenta, tiene que reusar SU fila y
  --    no abrir una segunda.
  select id into v_id
    from public.subscriptions
   where tenant_id = p_tenant_id
     and status in ('trialing', 'active', 'past_due', 'incomplete')
   limit 1;

  if v_id is not null then
    return v_id;
  end if;

  -- 3. (antes que el 2, porque es la salida) Ninguna fila dada de baja
  --    significa que no hay nada que re-dar de alta.
  if not exists (
    select 1 from public.subscriptions
     where tenant_id = p_tenant_id and status = 'canceled'
  ) then
    return null;
  end if;

  -- 2. El re-alta.
  begin
    insert into public.subscriptions (
      tenant_id, plan, status,
      current_period_start, current_period_end,
      trial_ends_at, price_usd_cents
    )
    values (
      p_tenant_id, p_plan, 'incomplete',
      p_now - interval '1 day', p_now,
      null, 0
    )
    returning id into v_id;
  exception when unique_violation then
    -- Otra llamada concurrente ganó la carrera contra
    -- `subscriptions_one_pending_per_tenant`. Su fila es tan buena como la que
    -- íbamos a escribir: se devuelve esa. Reintentar el insert abriría el
    -- segundo cobro que el índice acaba de impedir.
    select id into v_id
      from public.subscriptions
     where tenant_id = p_tenant_id and status = 'incomplete';
  end;

  return v_id;
end;
$$;

comment on function public.open_subscription_for_charge(uuid, public.plan_tier, timestamptz) is
  'Devuelve la suscripción a la que atarle un cobro. Si el negocio no tiene '
  'ninguna cobrable pero sí una dada de baja, abre una `incomplete` — el '
  're-alta, sin segunda prueba gratis. Null si el negocio no tiene ninguna '
  'fila, que es un estado roto y no un caso a tapar.';

revoke execute on function public.open_subscription_for_charge(uuid, public.plan_tier, timestamptz)
  from public, anon, authenticated;
grant execute on function public.open_subscription_for_charge(uuid, public.plan_tier, timestamptz)
  to service_role;
