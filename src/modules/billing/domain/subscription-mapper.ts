import type { PlanTier } from "@/modules/tenants/domain/types";

import type { Subscription, SubscriptionStatus } from "./subscription";

/** Fila cruda de `public.subscriptions` (columnas ver migration 0013). */
export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan: PlanTier;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  trial_ends_at: string | null;
  price_usd_cents: number;
  charged_amount_cents: number | null;
  charged_currency: string;
  fx_rate: number | null;
  fx_source: string | null;
  fx_quoted_at: string | null;
}

/** `null` sigue siendo `null`; convertirlo daría `Invalid Date`. */
const toDate = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

/**
 * Fila de `subscriptions` → `Subscription`. Función pura, sin I/O.
 *
 * Las fechas se convierten a `Date` acá y no más adelante: PostgREST las manda
 * como texto, y el dominio hace aritmética de tiempo con ellas. Dejarlas pasar
 * como string no rompería en el borde sino adentro del cálculo, que es el peor
 * lugar para enterarse.
 */
export function toSubscription(r: SubscriptionRow): Subscription {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    plan: r.plan,
    status: r.status,
    currentPeriodStart: new Date(r.current_period_start),
    currentPeriodEnd: new Date(r.current_period_end),
    trialEndsAt: toDate(r.trial_ends_at),
    priceUsdCents: r.price_usd_cents,
    chargedAmountCents: r.charged_amount_cents,
    chargedCurrency: r.charged_currency,
    fxRate: r.fx_rate,
    fxSource: r.fx_source,
    fxQuotedAt: toDate(r.fx_quoted_at),
  };
}
