-- ============================================================
-- 0018 — Un cobro, un período.
--
-- EL PROBLEMA, otra vez con el caso real que lo destapó.
--
-- Un solo pago produce DOS notificaciones y las dos mapean a `active`:
--
--   preapproval.authorized        05:01:04   la suscripción quedó autorizada
--   authorized_payment.processed  05:02:37   el cobro del mes entró
--
-- Las dos entraban a la rama que rota el período, y como el freno de
-- `billing_events` es por EVENTO —y son dos eventos distintos, con clave
-- distinta, del mismo cobro— ninguna de las dos se descartaba. Quedaron dos
-- filas en `usage_periods` para el mismo mes pagado.
--
-- Consecuencia: el consumo del mes se reinicia dos veces. El negocio recupera
-- cuota que ya gastó. Falla en silencio y del lado que perjudica al que cobra.
--
-- LA DISTINCIÓN QUE FALTABA: los dos avisos dicen cosas distintas.
--
--   * `preapproval` habla de la SUSCRIPCIÓN: quedó autorizada, se pausó, se dio
--     de baja. Mueve el estado y el permiso efectivo.
--
--   * `authorized_payment` habla de UN COBRO concreto. Es el único que compra
--     un mes, así que es el único que puede rotar el período.
--
-- No se resuelve por reloj. Dos llegadas separadas por segundos producen
-- `p_now` distintos y las dos parecen nuevas — es el mismo razonamiento por el
-- que `billing_events` existe. Se resuelve por QUÉ tipo de aviso es, que es un
-- dato que ya viaja y que hasta ahora se tiraba.
-- ============================================================

-- La firma cambia, así que la vieja se va explícitamente. `create or replace`
-- con otra lista de parámetros dejaría LAS DOS vivas, y `service_role` podría
-- seguir llamando a la de antes — que es justamente la que rota de más.
drop function if exists public.apply_subscription_payment(
  text, text, text, text, public.subscription_status, timestamptz
);

create or replace function public.apply_subscription_payment(
  p_provider                 text,
  p_provider_event_id        text,
  p_provider_subscription_id text,
  -- De qué habla el aviso: 'preapproval' o 'authorized_payment'. Espeja
  -- `WebhookEventKind` de `webhook-event.ts`.
  p_kind                     text,
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
  v_ref        public.subscription_provider_refs;
  v_sub        public.subscriptions;
  v_period_end timestamptz;
  v_claimed    int;
  v_rotates    boolean;
begin
  if p_status = 'trialing' then
    return 'invalid_status';
  end if;

  -- Un tipo que no conocemos NO se aplica a medias. Que llegue algo fuera de
  -- estos dos significa que río arriba cambió el mapeo, y adivinar cuál de los
  -- dos comportamientos corresponde sería inventar.
  if p_kind not in ('preapproval', 'authorized_payment') then
    return 'invalid_status';
  end if;

  -- ACÁ ESTÁ EL ARREGLO. Sólo el aviso de un cobro compra un mes.
  v_rotates := p_kind = 'authorized_payment';

  select * into v_ref
    from public.subscription_provider_refs
   where provider                 = p_provider
     and provider_subscription_id = p_provider_subscription_id;

  -- Sigue siendo el camino de la carrera con el checkout: Mercado Pago puede
  -- notificar antes de que `attach_subscription_checkout` alcance a escribir.
  -- No registrando nada acá, el reintento de Mercado Pago la arregla.
  if not found then
    return 'unknown_subscription';
  end if;

  select * into v_sub
    from public.subscriptions
   where id        = v_ref.subscription_id
     and tenant_id = v_ref.tenant_id
   for update;

  if not found then
    return 'unknown_subscription';
  end if;

  if v_sub.status = 'canceled' then
    return 'not_live';
  end if;

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
    -- El estado y el permiso efectivo se mueven con CUALQUIERA de los dos
    -- avisos. Que la suscripción quedó autorizada es motivo suficiente para
    -- dejar entrar al negocio; esperar al aviso del cobro lo dejaría afuera
    -- durante el minuto y medio que hay entre uno y otro.
    update public.subscriptions
       set status = 'active',
           plan   = v_ref.plan
     where id = v_sub.id;

    update public.tenants
       set plan = v_ref.plan
     where id = v_sub.tenant_id;

    -- El período y la cuota, en cambio, sólo los mueve el cobro.
    if v_rotates then
      v_period_end := p_now + interval '1 month';

      update public.subscriptions
         set current_period_start = p_now,
             current_period_end   = v_period_end
       where id = v_sub.id;

      insert into public.usage_periods (
        subscription_id, tenant_id, period_start, period_end
      )
      values (v_sub.id, v_sub.tenant_id, p_now, v_period_end)
      on conflict (subscription_id, period_start) do nothing;
    end if;

  elsif p_status = 'past_due' then
    -- Falló el cobro y el servicio SIGUE ANDANDO: `tenants.plan` no se toca.
    -- El período tampoco rota: no se cobró nada, así que no empezó nada.
    update public.subscriptions
       set status = 'past_due'
     where id = v_sub.id;

  elsif p_status = 'canceled' then
    update public.subscriptions
       set status = 'canceled'
     where id = v_sub.id;

    update public.tenants
       set plan = 'basico'
     where id = v_sub.tenant_id;
  end if;

  return 'applied';
end;
$$;

comment on function public.apply_subscription_payment(
  text, text, text, text, text, public.subscription_status, timestamptz
) is
  'Aplica una notificación de cobro sobre la suscripción dueña del preapproval, '
  'con el plan pactado en ese preapproval. Sólo un aviso de tipo '
  'authorized_payment rota el período y la cuota: un cobro, un mes. '
  'Idempotente por (provider, provider_event_id). Devuelve uno de: '
  'applied | duplicate | unknown_subscription | not_live | invalid_status.';

revoke execute on function public.apply_subscription_payment(
  text, text, text, text, text, public.subscription_status, timestamptz
) from public, anon, authenticated;

grant execute on function public.apply_subscription_payment(
  text, text, text, text, text, public.subscription_status, timestamptz
) to service_role;
