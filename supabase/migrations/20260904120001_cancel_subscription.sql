-- ============================================================
-- El dueño se da de baja, y se queda con lo que pagó.
--
-- Hasta acá la única acción de billing era `startCheckoutAction`: se podía
-- entrar y no salir. La baja se pedía por fuera del producto —desde el panel
-- de Mercado Pago— y llegaba de rebote por el webhook, que ya sabía aplicarla.
-- Lo que faltaba era la puerta.
--
-- LA DECISIÓN QUE ESTA MIGRACIÓN IMPLEMENTA: la baja corta el COBRO, no el
-- servicio. Quien pagó hasta el 30 y se da de baja el 5 sigue tomando turnos
-- hasta el 30. Cobrarle un mes y sacárselo el día que avisa que se va es
-- quedarse con plata por un servicio que no se prestó, y además vuelve
-- miedoso un botón que tiene que ser tranquilo: el que no puede salir sin
-- perder lo pagado, no entra.
--
-- Esto obliga a tocar `tenant_takes_bookings()`, que hasta hoy congelaba a
-- cualquier `canceled` en el acto. Es la misma función que 20260903120001
-- puso a frenar la prueba vencida, y se toca por el mismo criterio con el que
-- se escribió: manda el HECHO —hasta cuándo está pago— y no la etiqueta.
-- ============================================================

-- ------------------------------------------------------------
-- ¿Este negocio puede recibir turnos nuevos?
--
-- Cambia UNA cosa contra la versión de 20260903120001: una suscripción dada
-- de baja habilita mientras su período pago siga corriendo.
--
-- `current_period_end` es la fecha correcta y no `trial_ends_at`, porque es la
-- que responde "hasta cuándo está pago" en los DOS casos. Un negocio que se da
-- de baja durante la prueba también queda cubierto sin escribir un caso
-- aparte: `create_business` abre la fila con
-- `current_period_end = trial_ends_at`, así que la prueba ES su período. Un
-- `or` menos que mantener.
--
-- La columna es `not null`, así que acá no hay un nulo que pueda colarse como
-- true — a diferencia de `trial_ends_at`, que es nullable y por eso sigue
-- exigiendo su comparación explícita.
--
-- Lo que NO cambia, y conviene decirlo porque es la mitad del diseño: pasada
-- esa fecha el negocio se congela SOLO. Nada tiene que correr, ningún cron
-- tiene que despertarse. La fila se queda como está y la comparación con
-- `now()` deja de dar true. Es el mismo mecanismo con el que vence la prueba,
-- y por eso no hace falta un proceso que apague nada.
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
        or (s.status = 'trialing' and s.trial_ends_at    > now())
        or (s.status = 'canceled' and s.current_period_end > now())
      )
  );
$$;

comment on function public.tenant_takes_bookings(uuid) is
  'Si el negocio puede recibir turnos NUEVOS. Mira la suscripción, nunca '
  '`tenants.plan`. Una baja habilita hasta el fin del período ya pagado; '
  'pasada esa fecha se congela sola, sin proceso que la apague.';

-- ------------------------------------------------------------
-- Dar de baja la suscripción viva de un negocio.
--
-- NO toca `current_period_end`, y eso es la función entera: mover esa fecha a
-- `now()` sería la baja inmediata que este cambio decidió no hacer.
--
-- Tampoco toca `tenants.plan`. El plan efectivo es lo que el negocio PUEDE
-- usar hasta que termine el período, y bajarlo acá le sacaría el techo de
-- profesionales y de turnos que todavía tiene pago. Cuando el período venza,
-- `tenant_takes_bookings()` deja de habilitar y eso alcanza: no hay nada que
-- degradar porque no entra trabajo nuevo.
--
-- QUIÉN LA LLAMA Y EN QUÉ ORDEN. La llama el servidor DESPUÉS de que Mercado
-- Pago confirmó la baja del preapproval, nunca antes. El orden importa y no es
-- intercambiable:
--
--   · Si se escribe acá primero y Mercado Pago falla, la fila dice "dada de
--     baja" mientras la tarjeta se sigue debitando todos los meses. Es el
--     peor desenlace posible de esta función.
--   · Si Mercado Pago corta y esta escritura falla, no se le cobra más y
--     nuestra fila queda vieja — y el webhook `preapproval.cancelled` llega
--     después y la corrige solo. Se arregla sola.
--
-- Devuelve texto y no boolean porque los tres desenlaces piden respuestas
-- distintas de quien llama: 'canceled' se le informa, 'already_canceled' se
-- trata como éxito (el botón se apretó dos veces, o el webhook se adelantó), y
-- 'no_subscription' es un estado que no debería existir y merece decirlo.
--
-- `security definer` porque `subscriptions` no tiene policy de UPDATE para
-- nadie: el negocio LEE su suscripción y no la escribe, o se pondría
-- `premium` solo. El grant queda en `service_role`, igual que
-- `attach_subscription_checkout`: quien decide que el que pide la baja es el
-- dueño es el server action, con la sesión en la mano.
-- ------------------------------------------------------------
create or replace function public.cancel_subscription(p_tenant_id uuid)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_updated uuid;
begin
  update public.subscriptions
     set status = 'canceled'
   where tenant_id = p_tenant_id
     and status in ('trialing', 'active', 'past_due')
  returning id into v_updated;

  if v_updated is not null then
    return 'canceled';
  end if;

  -- No se actualizó nada: o ya estaba dada de baja, o no hay fila. Son
  -- desenlaces distintos y el `exists` los separa en vez de colapsarlos en un
  -- "no pasó nada" que esconde una base inconsistente.
  if exists (
    select 1 from public.subscriptions
     where tenant_id = p_tenant_id and status = 'canceled'
  ) then
    return 'already_canceled';
  end if;

  return 'no_subscription';
end;
$$;

comment on function public.cancel_subscription(uuid) is
  'Pasa a `canceled` la suscripción viva del negocio, sin tocar '
  '`current_period_end` ni `tenants.plan`: el servicio sigue hasta el fin del '
  'período pagado. La llama el servidor DESPUÉS de confirmar la baja en la '
  'pasarela. Devuelve canceled | already_canceled | no_subscription.';

revoke execute on function public.cancel_subscription(uuid) from public, anon, authenticated;
grant  execute on function public.cancel_subscription(uuid) to service_role;
