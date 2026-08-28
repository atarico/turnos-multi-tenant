-- ============================================================
-- 0014 — La prueba gratis nace con el negocio
--
-- `create_business` ya creaba negocio y membresía en UNA transacción, con el
-- argumento de que un negocio sin dueño o un dueño sin negocio son estados
-- rotos. La suscripción entra por la misma puerta y por la misma razón: un
-- negocio sin suscripción es un negocio del que no se sabe qué puede hacer.
--
-- 14 días, SIN tarjeta. La prueba se maneja con una fecha y no toca la
-- pasarela: pedir tarjeta de entrada mata la conversión en este segmento.
-- ============================================================

create or replace function public.create_business(
  p_name     text,
  p_slug     text,
  p_country  text,
  p_timezone text default 'America/Argentina/Buenos_Aires'
)
returns public.tenants
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant public.tenants;
  v_trial_ends timestamptz;
  v_started_at timestamptz;
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  insert into public.tenants (name, slug, country, timezone)
  values (p_name, p_slug, p_country, coalesce(p_timezone, 'America/Argentina/Buenos_Aires'))
  returning * into v_tenant;

  insert into public.memberships (user_id, tenant_id, role)
  values (auth.uid(), v_tenant.id, 'owner');

  -- Un solo reloj para el período: si cada insert leyera su propio `now()`,
  -- el período de consumo arrancaría unos microsegundos después que el de la
  -- suscripción y las dos filas dejarían de calzar.
  v_started_at := now();
  v_trial_ends := v_started_at + interval '14 days';

  -- El primer período ES la prueba: arranca ahora y termina cuando termina la
  -- prueba. Así el reseteo de contadores y el primer cobro caen el mismo día,
  -- y no hay que inventar un período cero.
  --
  -- `price_usd_cents` en 0 no es un plan gratis: es que durante la prueba no
  -- hay nada que cobrar. El precio real se estampa en el checkout, junto con
  -- la cotización del día. Ver `subscriptions.fx_rate`.
  insert into public.subscriptions (
    tenant_id,
    plan,
    status,
    current_period_start,
    current_period_end,
    trial_ends_at,
    price_usd_cents
  )
  values (
    v_tenant.id,
    v_tenant.plan,   -- el plan efectivo del negocio recién creado ('basico')
    'trialing',
    v_started_at,
    v_trial_ends,
    v_trial_ends,
    0
  )
  returning id into v_subscription_id;

  -- El período de consumo nace con la suscripción y con las MISMAS fechas.
  -- Sin esta fila, un negocio nuevo tendría suscripción viva y ningún lugar
  -- donde contar lo que gasta: el primer mensaje de WhatsApp tendría que
  -- crear el período sobre la marcha, y ese camino sólo se ejercita en
  -- producción. Mejor que exista desde el minuto cero.
  insert into public.usage_periods (
    subscription_id,
    tenant_id,
    period_start,
    period_end
  )
  values (
    v_subscription_id,
    v_tenant.id,
    v_started_at,
    v_trial_ends
  );

  return v_tenant;
end;
$$;

-- ---------- Backfill de los negocios que ya existen ----------
-- La función de arriba sólo alcanza a los negocios FUTUROS. Sin esto, el día
-- que corra esta migración todos los negocios ya creados quedarían sin
-- suscripción y sin período de consumo — o sea, exactamente el estado que el
-- encabezado de este archivo declara inaceptable, y encima el camino de
-- "crear el período sobre la marcha" seguiría siendo el único que tienen.
--
-- Se les da una prueba fresca de 14 días desde el momento de la migración. Es
-- la opción generosa a propósito: son negocios que ya venían usando el
-- producto sin que existieran los planes, y arrancarlos vencidos sería
-- cobrarles retroactivamente por una decisión nuestra.
--
-- Idempotente por el `not exists`: correr la migración dos veces no duplica
-- nada, y el índice único parcial `subscriptions_one_live_per_tenant` es la
-- red por si el `not exists` alguna vez se lee mal.
with nuevas as (
  insert into public.subscriptions (
    tenant_id,
    plan,
    status,
    current_period_start,
    current_period_end,
    trial_ends_at,
    price_usd_cents
  )
  select
    t.id,
    t.plan,
    'trialing',
    now(),
    now() + interval '14 days',
    now() + interval '14 days',
    0
  from public.tenants t
  where not exists (
    select 1
    from public.subscriptions s
    where s.tenant_id = t.id
      and s.status in ('trialing', 'active', 'past_due')
  )
  returning id, tenant_id, current_period_start, current_period_end
)
insert into public.usage_periods (
  subscription_id,
  tenant_id,
  period_start,
  period_end
)
select id, tenant_id, current_period_start, current_period_end
from nuevas;
