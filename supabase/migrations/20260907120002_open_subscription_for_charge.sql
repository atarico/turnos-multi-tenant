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
--   · El período NO es de relleno: se hereda de la baja, y es la mitad del
--     diseño. Ver el bloque de abajo.
--   · `price_usd_cents` en 0 porque el precio todavía no se calculó — sale de
--     la cotización del día, que `startCheckout` pide DESPUÉS de este paso. Lo
--     estampa `attach_subscription_checkout` unos milisegundos más tarde, y
--     hasta entonces nadie lee el precio de una fila `incomplete`.
--
-- EL PERÍODO SE HEREDA DE LA BAJA, Y NO ES UN DETALLE.
--
-- La baja corta el cobro y NO el servicio: quien pagó hasta el 30 y se dio de
-- baja el 5 sigue tomando turnos hasta el 30 (20260904120001). Si se da de
-- alta el 10 y no termina de pagar, esos 20 días siguen siendo suyos — ya los
-- pagó, y empezar un checkout no se los puede quitar.
--
-- Un período de relleno ya vencido se los quitaba. Del lado de la base no,
-- porque `tenant_takes_bookings()` es un `exists` sobre TODAS las filas y la
-- cancelada seguía habilitando; pero `getCurrentSubscription` trae LA MÁS
-- NUEVA, así que `takesNewBookings` juzgaba sólo la fila `incomplete` y decía
-- que no. Las dos superficies contestaban distinto sobre el mismo negocio:
-- `/panel/nueva-reserva` le escondía el formulario mientras `create_booking()`
-- se lo habría aceptado. Es la falla que el comentario de `takesNewBookings`
-- advierte, y esta vez apuntando para el otro lado.
--
-- Heredarlo lo arregla en el origen y sin una sola rama: la fila nueva dice
-- hasta cuándo está pago, que es el HECHO que las dos superficies miran. Si la
-- baja ya venció, hereda una fecha pasada y no habilita nada — el mismo
-- resultado que el relleno, por la regla correcta en vez de por casualidad.
-- Se toma la baja de período MÁS LARGO y no la más nueva: lo que se hereda es
-- "hasta cuándo está pago", y esa es la mayor.
--
-- Lo pisa el primer cobro: `apply_subscription_payment` rota el período recién
-- cuando llega el aviso de un pago de verdad.
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
  v_id    uuid;
  v_start timestamptz;
  v_end   timestamptz;
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
  --    significa que no hay nada que re-dar de alta. La misma consulta trae el
  --    período que se hereda: la baja que llega más lejos.
  select current_period_start, current_period_end
    into v_start, v_end
    from public.subscriptions
   where tenant_id = p_tenant_id
     and status = 'canceled'
   order by current_period_end desc
   limit 1;

  if not found then
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
      v_start, v_end,
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
  'ninguna cobrable pero sí una dada de baja, abre una `incomplete` heredando '
  'el período pago de esa baja — el re-alta, sin segunda prueba gratis y sin '
  'quitarle los días que ya pagó. Null si el negocio no tiene ninguna fila, '
  'que es un estado roto y no un caso a tapar.';

-- ------------------------------------------------------------
-- Y el período heredado tiene que HABILITAR mientras corra.
--
-- Cambia UNA cosa contra la versión de 20260904120001: `incomplete` habilita
-- igual que `canceled`, mientras su período siga vigente. Es el mismo criterio
-- con el que se escribió aquélla —manda el HECHO, hasta cuándo está pago, y no
-- la etiqueta— aplicado a la fila que ahora hereda ese hecho.
--
-- Hoy esta cláusula es redundante: el `exists` recorre TODAS las filas del
-- negocio y la cancelada de la que se heredó sigue habilitando por su cuenta.
-- Está igual, y a propósito: sin ella, la base y `takesNewBookings` llegan a la
-- misma respuesta leyendo filas DISTINTAS, y dos caminos para una sola regla es
-- exactamente cómo se separan. Acá las dos leen la misma fila y el mismo campo.
-- ------------------------------------------------------------
create or replace function public.tenant_takes_bookings(p_tenant_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.tenant_id = p_tenant_id
      and (
        s.status in ('active', 'past_due')
        or (s.status = 'trialing'   and s.trial_ends_at      > now())
        or (s.status = 'canceled'   and s.current_period_end > now())
        or (s.status = 'incomplete' and s.current_period_end > now())
      )
  );
$$;

comment on function public.tenant_takes_bookings(uuid) is
  'Si el negocio puede recibir turnos NUEVOS. Mira la suscripción, nunca '
  '`tenants.plan`. Una baja habilita hasta el fin del período ya pagado, y un '
  're-alta hereda ese período; pasada esa fecha se congela sola, sin proceso '
  'que la apague.';

revoke execute on function public.open_subscription_for_charge(uuid, public.plan_tier, timestamptz)
  from public, anon, authenticated;
grant execute on function public.open_subscription_for_charge(uuid, public.plan_tier, timestamptz)
  to service_role;
