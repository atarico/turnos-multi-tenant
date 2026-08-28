import { describe, expect, it } from "vitest";

import { type SubscriptionRow, toSubscription } from "./subscription-mapper";

/**
 * El mapeo no es cosmético: las fechas llegan de PostgREST como STRINGS, y
 * `isInTrial` y `trialDaysLeft` hacen aritmética de tiempo. Si el mapper las
 * dejara pasar como texto, `getTime()` no existiría y el cálculo reventaría —
 * o peor, una comparación de strings daría un resultado plausible y falso.
 */

const row: SubscriptionRow = {
  id: "sub-1",
  tenant_id: "tenant-1",
  plan: "pro",
  status: "trialing",
  current_period_start: "2026-08-17T12:00:00Z",
  current_period_end: "2026-08-31T12:00:00Z",
  trial_ends_at: "2026-08-31T12:00:00Z",
  price_usd_cents: 3500,
  charged_amount_cents: null,
  charged_currency: "ARS",
  fx_rate: null,
  fx_source: null,
  fx_quoted_at: null,
};

describe("toSubscription", () => {
  it("pasa los campos simples a camelCase", () => {
    const subscription = toSubscription(row);

    expect(subscription.id).toBe("sub-1");
    expect(subscription.tenantId).toBe("tenant-1");
    expect(subscription.plan).toBe("pro");
    expect(subscription.status).toBe("trialing");
    expect(subscription.priceUsdCents).toBe(3500);
    expect(subscription.chargedCurrency).toBe("ARS");
  });

  it("convierte las fechas a Date, no las deja como texto", () => {
    const subscription = toSubscription(row);

    expect(subscription.currentPeriodStart).toBeInstanceOf(Date);
    expect(subscription.currentPeriodEnd).toBeInstanceOf(Date);
    expect(subscription.trialEndsAt).toBeInstanceOf(Date);
    expect(subscription.trialEndsAt?.toISOString()).toBe("2026-08-31T12:00:00.000Z");
  });

  // Sin prueba, `trial_ends_at` viene null y tiene que seguir siendo null:
  // convertirlo daría `Invalid Date`, que es peor que ausente.
  it("una fecha nula sigue nula", () => {
    const subscription = toSubscription({ ...row, trial_ends_at: null });

    expect(subscription.trialEndsAt).toBeNull();
  });

  it("los montos y la cotización opcionales pasan tal cual", () => {
    const subscription = toSubscription({
      ...row,
      charged_amount_cents: 4550000,
      fx_rate: 1300.5,
      fx_source: "dolarapi:mep",
      fx_quoted_at: "2026-08-17T09:00:00Z",
    });

    expect(subscription.chargedAmountCents).toBe(4550000);
    expect(subscription.fxRate).toBe(1300.5);
    expect(subscription.fxSource).toBe("dolarapi:mep");
    expect(subscription.fxQuotedAt).toBeInstanceOf(Date);
  });
});
