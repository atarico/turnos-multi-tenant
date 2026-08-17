-- 0015 — Estampar el checkout en la suscripción.
--
-- La tabla `subscriptions` tiene RLS con SELECT y NADA de escritura, y eso es
-- la decisión, no un olvido: un dueño que pudiera hacer UPDATE sobre su propia
-- suscripción se pondría en premium. Los dos caminos de escritura declarados en
-- `20260817120001_subscriptions.sql` son `service_role` y funciones
-- SECURITY DEFINER. Esta es la primera de esas funciones.
--
-- Qué estampa: el precio del plan elegido, el monto realmente cobrable en pesos
-- con la cotización que lo produjo, y el par (proveedor, id del proveedor) que
-- ata nuestra fila con la suscripción del otro lado.
--
-- Qué NO toca, a propósito:
--
--   * `status` — sigue en `trialing` hasta que un cobro entre de verdad. Quien
--     lo mueve es el webhook, que es la tajada siguiente. Ponerlo en `active`
--     acá diría que se está cobrando cuando lo único que pasó es que alguien
--     apretó un botón.
--
--   * `tenants.plan` — que es el permiso efectivo que se consulta en cada
--     request. `subscriptions.plan` es lo que se está por PAGAR; `tenants.plan`
--     es lo que se puede USAR. Moverlos juntos acá le daría los límites del
--     plan caro a alguien que todavía no pagó nada.
--
--   * los períodos — `current_period_start` y `current_period_end` los rota el
--     cobro, no el checkout.

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
  -- El par (id, tenant_id) y no sólo el id. La función corre con SECURITY
  -- DEFINER, o sea que saltea RLS: si filtrara sólo por `id`, quien llame con
  -- el id de la suscripción de otro negocio se la estampa. El tenant_id no es
  -- redundante acá, es el único control de pertenencia que queda.
  --
  -- Y sólo sobre una suscripción VIVA. Estampar un checkout sobre una
  -- `canceled` la dejaría con datos de cobro y sin nada que la cobre.
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

  -- Devuelve si tocó algo en vez de romper. Cero filas no es un error de
  -- sistema: es que la suscripción no existe, no es de este negocio, o ya está
  -- cancelada. Quien llama necesita distinguir eso de un fallo de base, y un
  -- `raise` los colapsaría en la misma pantalla de error.
  return v_updated = 1;
end;
$$;

comment on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
) is
  'Estampa precio, cotización y el id de la pasarela sobre una suscripción viva. '
  'No mueve el estado ni el permiso efectivo: eso lo hace el webhook del cobro.';

-- Postgres le da EXECUTE a PUBLIC por defecto, y encima Supabase tiene un
-- ALTER DEFAULT PRIVILEGES que se lo da explícitamente a `anon` y
-- `authenticated`. Revocar de uno solo de los tres deja la función abierta.
-- Ver la nota larga en `20260808120001_public_booking_throttle.sql`.
revoke execute on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
) from public, anon, authenticated;

-- Sólo el servidor. Esta función saltea RLS sobre una tabla de cobro: si
-- `authenticated` pudiera ejecutarla, cualquier dueño se estampa el plan que
-- quiera con el precio que quiera.
grant execute on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
) to service_role;
