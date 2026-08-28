-- ============================================================
-- 0017 — Un preapproval sigue encontrando su suscripción aunque venga otro.
--
-- EL PROBLEMA, con el caso real que lo destapó.
--
-- `attach_subscription_checkout` pisa `provider_subscription_id` sobre una
-- suscripción que puede estar YA activa y cobrando —el `where` acepta 'active'
-- a propósito, porque cambiar de plan es un caso legítimo—. Pero al pisarlo, el
-- preapproval anterior, que es EL QUE SIGUE COBRANDO TODOS LOS MESES, se queda
-- sin nadie que lo referencie.
--
-- Lo que pasa el mes siguiente: llega el `authorized_payment` de ese preapproval,
-- `apply_subscription_payment` lo busca por `provider_subscription_id`, NO lo
-- encuentra, y devuelve `unknown_subscription`. El Route Handler contesta 5xx
-- —correctamente, porque ese código significa "reintentá"— y Mercado Pago
-- reintenta cada quince minutos PARA SIEMPRE algo que no va a mejorar nunca. El
-- negocio paga y no se le renueva nada.
--
-- Falla en silencio y del lado que perjudica al cliente, que es exactamente la
-- clase de falla que el resto de este módulo se esfuerza en evitar.
--
-- LA SOLUCIÓN: que la identidad del lado de la pasarela deje de vivir en una
-- columna que se pisa, y pase a ser una fila propia que se acumula.
--
-- Y con el plan adentro. Esa es la parte que no es obvia: el cobro que llega
-- corresponde a lo que se pactó CUANDO SE ABRIÓ ESE PREAPPROVAL, no a lo que
-- diga `subscriptions.plan` hoy. Leer el plan de la suscripción sería darle
-- premium a quien pagó básico nada más porque después miró la pantalla de
-- planes.
-- ============================================================

create table public.subscription_provider_refs (
  provider                 text not null,
  provider_subscription_id text not null,

  subscription_id uuid not null,
  tenant_id       uuid not null,

  -- Lo pactado para ESTE preapproval, congelado. Ver la nota de arriba.
  plan                 public.plan_tier not null,
  charged_amount_cents int,

  attached_at timestamptz not null default now(),

  -- Un id de pasarela, UNA suscripción. Es el mismo invariante que sostenía el
  -- índice único de `subscriptions`, mudado acá: si dos suscripciones pudieran
  -- compartir un id, el cobro de un negocio activaría al otro.
  primary key (provider, provider_subscription_id),

  -- El par (id, tenant_id) y no dos claves sueltas, igual que en
  -- `billing_events` y `usage_periods`: impide una fila con la suscripción de
  -- un negocio y el `tenant_id` de otro.
  constraint subscription_provider_refs_subscription_fkey
    foreign key (subscription_id, tenant_id)
    references public.subscriptions(id, tenant_id) on delete cascade
);

create index subscription_provider_refs_subscription_idx
  on public.subscription_provider_refs(subscription_id);

-- Sin ninguna policy, por la misma razón que `billing_events`: es maquinaria de
-- cobro, no información del negocio. RLS habilitado sin policies deja la tabla
-- accesible sólo para `service_role`.
alter table public.subscription_provider_refs enable row level security;

-- ---------- Traer lo que ya existe ----------
-- Las suscripciones que hoy tienen un id de pasarela estampado. Su plan actual
-- es lo mejor que se puede saber retroactivamente: no hay registro de qué se
-- pactó en cada checkout anterior, justamente porque eso es lo que faltaba.
insert into public.subscription_provider_refs (
  provider, provider_subscription_id, subscription_id, tenant_id,
  plan, charged_amount_cents, attached_at
)
select provider, provider_subscription_id, id, tenant_id,
       plan, charged_amount_cents, coalesce(updated_at, created_at)
  from public.subscriptions
 where provider is not null
   and provider_subscription_id is not null
on conflict (provider, provider_subscription_id) do nothing;

-- ---------- attach_subscription_checkout ----------
-- Igual que antes, más la fila de identidad. `subscriptions.provider_subscription_id`
-- se sigue escribiendo: pasa a ser "cuál es el preapproval VIGENTE", que es una
-- pregunta distinta de "a quién pertenece este preapproval" y las dos hacen falta.
create or replace function public.attach_subscription_checkout(
  p_tenant_id                uuid,
  p_subscription_id          uuid,
  p_plan                     public.plan_tier,
  p_price_usd_cents          int,
  p_charged_amount_cents     int,
  p_fx_rate                  numeric,
  p_fx_source                text,
  p_fx_quoted_at             timestamptz,
  p_provider                 text,
  p_provider_subscription_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.subscriptions
     set plan                     = p_plan,
         price_usd_cents          = p_price_usd_cents,
         charged_amount_cents     = p_charged_amount_cents,
         charged_currency         = 'ARS',
         fx_rate                  = p_fx_rate,
         fx_source                = p_fx_source,
         fx_quoted_at             = p_fx_quoted_at,
         provider                 = p_provider,
         provider_subscription_id = p_provider_subscription_id
   where id        = p_subscription_id
     and tenant_id = p_tenant_id
     and status in ('trialing', 'active', 'past_due');

  get diagnostics v_updated = row_count;

  -- La fila de identidad SÓLO si el update tocó algo. Si la suscripción no era
  -- de este negocio o estaba cancelada, escribirla dejaría un preapproval
  -- apuntando a una suscripción que nunca aceptó el checkout.
  if v_updated = 1 then
    insert into public.subscription_provider_refs (
      provider, provider_subscription_id, subscription_id, tenant_id,
      plan, charged_amount_cents
    )
    values (
      p_provider, p_provider_subscription_id, p_subscription_id, p_tenant_id,
      p_plan, p_charged_amount_cents
    )
    -- Reintentar el mismo checkout no es un error. Un id de pasarela nuevo por
    -- intento es lo normal, así que esto casi nunca se activa; cuando lo hace,
    -- lo pactado ya quedó escrito y no hay nada que corregir.
    on conflict (provider, provider_subscription_id) do nothing;
  end if;

  return v_updated = 1;
end;
$$;

comment on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
) is
  'Estampa precio, cotización y el id de la pasarela sobre una suscripción viva, '
  'y registra la identidad del preapproval con el plan pactado. '
  'No mueve el estado ni el permiso efectivo: eso lo hace el webhook del cobro.';

revoke execute on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
) from public, anon, authenticated;

grant execute on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
) to service_role;

-- ---------- apply_subscription_payment ----------
-- Cambian DOS cosas, y las dos son el arreglo:
--
--   1. La suscripción se busca por la fila de identidad, no por la columna que
--      se pisa. Un preapproval viejo sigue encontrando su suscripción.
--   2. El plan que se aplica sale de esa fila, no de `subscriptions.plan`.
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
  v_ref        public.subscription_provider_refs;
  v_sub        public.subscriptions;
  v_period_end timestamptz;
  v_claimed    int;
begin
  -- `trialing` no es un destino al que se pueda VOLVER. La prueba la abre
  -- `create_business` una sola vez; una notificación de cobro que pida devolver
  -- a alguien a la prueba es un error del que mapea, no un caso de negocio.
  if p_status = 'trialing' then
    return 'invalid_status';
  end if;

  select * into v_ref
    from public.subscription_provider_refs
   where provider                 = p_provider
     and provider_subscription_id = p_provider_subscription_id;

  -- Sigue siendo el camino de la carrera con el checkout: Mercado Pago puede
  -- notificar antes de que `attach_subscription_checkout` alcance a escribir.
  -- No registrando nada acá, el reintento de Mercado Pago es lo que la arregla.
  if not found then
    return 'unknown_subscription';
  end if;

  -- `for update` porque entre esta lectura y el update puede entrar otra
  -- notificación del mismo preapproval: dos cobros del mismo mes llegando
  -- juntos rotarían el período dos veces.
  select * into v_sub
    from public.subscriptions
   where id        = v_ref.subscription_id
     and tenant_id = v_ref.tenant_id
   for update;

  if not found then
    return 'unknown_subscription';
  end if;

  -- Una suscripción cancelada no se revive por webhook.
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
    v_period_end := p_now + interval '1 month';

    -- `plan = v_ref.plan` y no el que tenga la fila: si alguien abrió un
    -- checkout nuevo sin pagarlo, `subscriptions.plan` quedó adelantado y este
    -- cobro corresponde al plan anterior.
    update public.subscriptions
       set status               = 'active',
           plan                 = v_ref.plan,
           current_period_start = p_now,
           current_period_end   = v_period_end
     where id = v_sub.id;

    update public.tenants
       set plan = v_ref.plan
     where id = v_sub.tenant_id;

    insert into public.usage_periods (
      subscription_id, tenant_id, period_start, period_end
    )
    values (v_sub.id, v_sub.tenant_id, p_now, v_period_end)
    on conflict (subscription_id, period_start) do nothing;

  elsif p_status = 'past_due' then
    -- Falló el cobro y el servicio SIGUE ANDANDO: `tenants.plan` no se toca.
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
  text, text, text, text, public.subscription_status, timestamptz
) is
  'Aplica una notificación de cobro sobre la suscripción dueña del preapproval, '
  'con el plan pactado en ese preapproval. Idempotente por '
  '(provider, provider_event_id). Devuelve uno de: '
  'applied | duplicate | unknown_subscription | not_live | invalid_status.';

revoke execute on function public.apply_subscription_payment(
  text, text, text, text, public.subscription_status, timestamptz
) from public, anon, authenticated;

grant execute on function public.apply_subscription_payment(
  text, text, text, text, public.subscription_status, timestamptz
) to service_role;
