-- ============================================================
-- 0016 — Aplicar un cobro de la pasarela sobre la suscripción.
--
-- `attach_subscription_checkout` deja estampado QUÉ se va a cobrar. Esta es la
-- otra mitad: qué pasa cuando el cobro EFECTIVAMENTE ocurre (o falla, o se da
-- de baja). Es la única función que mueve `subscriptions.status` y
-- `tenants.plan`, que es el permiso efectivo que se consulta en cada request.
--
-- La llama el Route Handler del webhook, DESPUÉS de verificar la firma. Esta
-- función no autentica nada: asume que quien la ejecuta ya probó que la
-- notificación es de Mercado Pago. Por eso el EXECUTE queda sólo en
-- `service_role`.
--
-- EL PROBLEMA CENTRAL ES LA IDEMPOTENCIA, no el UPDATE.
--
-- Mercado Pago REINTENTA. La misma notificación llega dos, tres, cinco veces,
-- y no hay forma de pedirle que no lo haga. Sin un freno, cada reintento rota
-- el período de nuevo: el consumo del mes se resetea a cero a mitad de mes y el
-- negocio se come mensajes de WhatsApp que ya gastó. Falla en silencio y del
-- lado que perjudica al cliente.
--
-- Reconocer el reintento por el reloj no sirve —dos llegadas separadas por
-- segundos producen `period_start` distintos y las dos parecen nuevas—, así que
-- el freno tiene que ser el ID del evento, que es lo único estable entre
-- reintentos. De ahí `billing_events`.
-- ============================================================

-- ---------- Un id de pasarela, una suscripción ----------
-- El webhook NO trae sesión ni negocio: lo único que trae es el id del
-- preapproval. O sea que ese id es la llave de entrada a nuestra fila, y si dos
-- suscripciones pudieran compartirlo, el cobro de un negocio activaría al otro.
--
-- Parcial porque `provider_subscription_id` es null hasta que se abre el
-- checkout, y un único común trataría a todos los nulls como... bueno, no:
-- Postgres no colapsa nulls en un único. El `where` está por otra razón — sin
-- él el índice carga todas las filas sin pasarela, que no se buscan nunca.
create unique index subscriptions_provider_subscription_id_key
  on public.subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;

-- ---------- billing_events ----------
-- El registro de qué notificaciones ya se aplicaron.
--
-- No es una bitácora "por si sirve": es el mecanismo. La fila SÓLO se escribe
-- cuando el evento realmente se aplicó, y el único sobre
-- (provider, provider_event_id) es lo que hace que el segundo intento choque en
-- vez de volver a cobrar el efecto.
create table public.billing_events (
  id       uuid primary key default gen_random_uuid(),
  provider text not null,
  -- El id del evento del lado de la pasarela. Estable entre reintentos: es la
  -- única cosa de la notificación que NO cambia cuando vuelve a llegar.
  provider_event_id text not null,

  -- A quién se le aplicó. Se guardan los dos y no sólo la suscripción porque
  -- esta tabla se lee cuando algo salió mal, y en ese momento tener que hacer
  -- un join para saber de qué negocio se está hablando es fricción pura.
  subscription_id uuid,
  tenant_id       uuid references public.tenants(id) on delete set null,

  -- Qué dijo la pasarela, crudo (`payment.created`, `subscription_preapproval`,
  -- lo que sea). Se guarda sin interpretar para poder reconstruir después qué
  -- llegó, incluso si el mapeo a nuestros estados cambia.
  event_type text not null,
  -- Y a qué lo tradujimos NOSOTROS. Los dos, porque el desacuerdo entre ambos
  -- es exactamente el bug que uno va a estar buscando.
  applied_status public.subscription_status not null,

  received_at timestamptz not null default now(),

  constraint billing_events_provider_event_key unique (provider, provider_event_id),

  -- El mismo par que sostiene `usage_periods`: referenciar (id, tenant_id) y no
  -- dos claves sueltas es lo que impide una fila con la suscripción de un
  -- negocio y el `tenant_id` de otro.
  constraint billing_events_subscription_fkey
    foreign key (subscription_id, tenant_id)
    references public.subscriptions(id, tenant_id) on delete set null
);

create index billing_events_subscription_idx on public.billing_events(subscription_id);
create index billing_events_tenant_id_idx    on public.billing_events(tenant_id);

-- Sin NINGUNA policy, a propósito y con más razón que en `subscriptions`: acá
-- no hay ni SELECT. Esto es maquinaria de cobro, no información del negocio, y
-- RLS habilitado sin policies deja la tabla accesible sólo para `service_role`.
alter table public.billing_events enable row level security;

-- ---------- apply_subscription_payment ----------
create or replace function public.apply_subscription_payment(
  p_provider                 text,
  p_provider_event_id        text,
  p_provider_subscription_id text,
  p_event_type               text,
  p_status                   public.subscription_status,
  p_now                      timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub        public.subscriptions;
  v_period_end timestamptz;
  v_claimed    int;
begin
  -- `trialing` no es un destino al que se pueda VOLVER. La prueba la abre
  -- `create_business` una sola vez; una notificación de cobro que pida
  -- devolver a alguien a la prueba es un error del que mapea, no un caso de
  -- negocio. Se corta acá, antes de tocar nada, y con un valor de retorno
  -- propio para que se pueda loguear en vez de aparecer como un 500 opaco.
  if p_status = 'trialing' then
    return 'invalid_status';
  end if;

  -- LA SUSCRIPCIÓN PRIMERO, EL EVENTO DESPUÉS. El orden importa y no es
  -- estético.
  --
  -- Hay una carrera real: Mercado Pago puede notificar ANTES de que
  -- `attach_subscription_checkout` alcance a estampar el `provider_subscription_id`
  -- de nuestro lado. Si en ese momento marcáramos el evento como procesado,
  -- el reintento —que llegaría cuando la fila ya existe— se descartaría como
  -- duplicado y el cobro no se aplicaría NUNCA.
  --
  -- No registrando nada en ese camino, el reintento de Mercado Pago se vuelve
  -- justamente el mecanismo que arregla la carrera.
  --
  -- `for update` porque entre esta lectura y el update de abajo puede entrar
  -- otra notificación del mismo preapproval: dos cobros del mismo mes llegando
  -- juntos rotarían el período dos veces.
  select * into v_sub
    from public.subscriptions
   where provider                 = p_provider
     and provider_subscription_id = p_provider_subscription_id
   for update;

  if not found then
    return 'unknown_subscription';
  end if;

  -- Una suscripción cancelada no se revive por webhook. Volver a ponerla viva
  -- acá chocaría contra `subscriptions_one_live_per_tenant` si el negocio ya
  -- abrió otra, y peor: reactivaría un cobro que alguien dio de baja a mano.
  -- Tampoco se registra el evento, así que esto es un no-op repetible.
  if v_sub.status = 'canceled' then
    return 'not_live';
  end if;

  -- Recién ahora se reclama el evento. Si otro reintento ya lo reclamó, el
  -- único choca y no se aplica nada por segunda vez.
  --
  -- Todo esto corre en UNA transacción: si algo de abajo revienta, el reclamo
  -- se va con el rollback y el próximo reintento vuelve a tener su chance. Un
  -- evento reclamado pero no aplicado sería lo peor de los dos mundos.
  insert into public.billing_events (
    provider, provider_event_id, subscription_id, tenant_id,
    event_type, applied_status
  )
  values (
    p_provider, p_provider_event_id, v_sub.id, v_sub.tenant_id,
    p_event_type, p_status
  )
  on conflict (provider, provider_event_id) do nothing;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'duplicate';
  end if;

  if p_status = 'active' then
    -- El cobro entró: rota el período y ES el momento en que el negocio gana
    -- el plan. Un mes, que es la frecuencia con la que se abrió el preapproval
    -- (`auto_recurring.frequency_type = 'months'`). Si esa frecuencia cambia,
    -- este intervalo cambia con ella.
    v_period_end := p_now + interval '1 month';

    update public.subscriptions
       set status               = 'active',
           current_period_start = p_now,
           current_period_end   = v_period_end
     where id = v_sub.id;

    -- El permiso efectivo. `subscriptions.plan` es lo que se PAGA;
    -- `tenants.plan` es lo que se puede USAR, y este es el único lugar donde
    -- el segundo se mueve hacia arriba. Denormalización declarada en
    -- `20260817120001_subscriptions.sql`.
    update public.tenants
       set plan = v_sub.plan
     where id = v_sub.tenant_id;

    -- Contadores en cero para el mes nuevo. El `on conflict` es redundante con
    -- el freno de `billing_events` y se queda igual: si alguna vez se llega
    -- acá dos veces con el mismo `period_start`, el peor desenlace posible es
    -- resetear el consumo a mitad de mes, y eso se atranca acá también.
    insert into public.usage_periods (
      subscription_id, tenant_id, period_start, period_end
    )
    values (v_sub.id, v_sub.tenant_id, p_now, v_period_end)
    on conflict (subscription_id, period_start) do nothing;

  elsif p_status = 'past_due' then
    -- Falló el cobro y el servicio SIGUE ANDANDO: `tenants.plan` no se toca.
    -- Esa es toda la razón por la que `past_due` existe como estado propio en
    -- vez de ser un `active` con una bandera. Bajarle el plan acá convertiría
    -- una tarjeta vencida en una caída de servicio el mismo día.
    --
    -- El período tampoco rota: no se cobró nada, así que no empezó nada.
    update public.subscriptions
       set status = 'past_due'
     where id = v_sub.id;

  elsif p_status = 'canceled' then
    update public.subscriptions
       set status = 'canceled'
     where id = v_sub.id;

    -- Al piso, que es lo mismo con lo que nace un negocio nuevo
    -- (`tenants.plan` default 'basico'). No se borra nada ni se bloquea el
    -- acceso: se pierden los límites del plan pago, que es lo que se dejó de
    -- pagar.
    update public.tenants
       set plan = 'basico'
     where id = v_sub.tenant_id;
  end if;

  return 'applied';
end;
$$;

comment on function public.apply_subscription_payment(
  text, text, text, text, public.subscription_status, timestamptz
) is
  'Aplica una notificación de cobro sobre la suscripción atada al preapproval. '
  'Idempotente por (provider, provider_event_id). Devuelve uno de: '
  'applied | duplicate | unknown_subscription | not_live | invalid_status.';

-- Postgres le da EXECUTE a PUBLIC por defecto, y Supabase encima se lo da
-- explícitamente a `anon` y `authenticated`. Revocar de uno solo de los tres
-- deja la función abierta. Ver la nota larga en
-- `20260808120001_public_booking_throttle.sql`.
revoke execute on function public.apply_subscription_payment(
  text, text, text, text, public.subscription_status, timestamptz
) from public, anon, authenticated;

-- Sólo el servidor. Esta función pone planes pagos: si `authenticated` pudiera
-- ejecutarla, cualquiera se activa premium inventando un id de evento.
grant execute on function public.apply_subscription_payment(
  text, text, text, text, public.subscription_status, timestamptz
) to service_role;
