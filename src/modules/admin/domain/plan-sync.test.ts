import { describe, expect, it } from "vitest";

import type { Subscription } from "@/modules/billing/domain/subscription";
import type { PlanTier } from "@/modules/tenants/domain/types";

import { planIsOutOfSync } from "./plan-sync";

function subscription(overrides: {
  plan: PlanTier;
  status: Subscription["status"];
}): Subscription {
  return {
    id: "s1",
    tenantId: "t1",
    plan: overrides.plan,
    status: overrides.status,
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    trialEndsAt: null,
    priceUsdCents: 1000,
    chargedAmountCents: null,
    chargedCurrency: "ARS",
    fxRate: null,
    fxSource: null,
    fxQuotedAt: null,
  };
}

describe("planIsOutOfSync", () => {
  it("no denuncia nada cuando los dos planes coinciden", () => {
    expect(
      planIsOutOfSync("premium", subscription({ plan: "premium", status: "active" })),
    ).toBe(false);
  });

  /**
   * Éste es el caso que la función existe para encontrar, y no es hipotético:
   * ya pasó en el sandbox. Un segundo checkout dejó `tenants.plan` en un plan
   * y la suscripción que REALMENTE cobra en otro. Desde el panel se veía un
   * negocio perfectamente normal.
   */
  it("denuncia cuando el negocio muestra un plan y la suscripción cobra otro", () => {
    expect(
      planIsOutOfSync("basico", subscription({ plan: "premium", status: "active" })),
    ).toBe(true);
  });

  it("también lo denuncia durante la prueba gratis", () => {
    expect(
      planIsOutOfSync("basico", subscription({ plan: "pro", status: "trialing" })),
    ).toBe(true);
  });

  /**
   * `past_due` es un cobro que falló, no una suscripción muerta: el servicio
   * sigue andando durante la gracia, así que su plan sigue siendo una promesa
   * vigente y una discrepancia sigue siendo un problema.
   */
  it("también lo denuncia con el cobro atrasado", () => {
    expect(
      planIsOutOfSync("basico", subscription({ plan: "pro", status: "past_due" })),
    ).toBe(true);
  });

  /**
   * Una suscripción cancelada es HISTORIA, no una promesa. Alguien que cancela
   * premium y cae a básico deja exactamente este cuadro —negocio en `basico`,
   * suscripción `premium`— y está perfectamente bien.
   *
   * Sin esta rama, todo negocio que alguna vez bajó de plan aparecería marcado
   * para siempre, y una alarma que suena cuando no pasa nada deja de mirarse:
   * el día que la discrepancia sea de verdad, nadie la va a ver.
   */
  it("no denuncia una suscripción cancelada, aunque su plan sea otro", () => {
    expect(
      planIsOutOfSync("basico", subscription({ plan: "premium", status: "canceled" })),
    ).toBe(false);
  });

  /** Sin suscripción no hay dos planes que comparar. */
  it("no denuncia nada cuando el negocio no tiene suscripción", () => {
    expect(planIsOutOfSync("basico", null)).toBe(false);
  });
});
