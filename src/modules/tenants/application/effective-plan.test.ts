import { describe, expect, it } from "vitest";

import { withEffectivePlan } from "./queries";
import type { Tenant } from "../domain/types";

/**
 * Tests del ÚNICO lugar donde una cortesía se convierte en permiso.
 *
 * `effectivePlan` ya está probada aparte, como función pura. Lo que se fija acá
 * es el CABLEADO: que la fila cruda de PostgREST —snake_case, fechas como
 * texto— llegue bien a esa función, y que lo pagado no se pierda en el camino.
 *
 * Si esto se rompe, no explota nada: simplemente un negocio con una cortesía
 * viva sigue chocando contra los límites del plan que paga, y el operador jura
 * que la otorgó. Por eso hay tests.
 */

const NOW = new Date("2026-08-30T12:00:00Z");

function row(overrides: Partial<Omit<Tenant, "paid_plan">> = {}) {
  return {
    id: "t1",
    slug: "acme",
    name: "Acme",
    country: "AR" as const,
    timezone: "America/Argentina/Buenos_Aires",
    plan: "basico" as const,
    plan_courtesy: null,
    plan_courtesy_until: null,
    plan_courtesy_reason: null,
    logo_url: null,
    brand_color: "#e3b23c",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("withEffectivePlan", () => {
  it("sin cortesía, el plan efectivo es el pagado", () => {
    const tenant = withEffectivePlan(row({ plan: "pro" }), NOW);

    expect(tenant.plan).toBe("pro");
    expect(tenant.paid_plan).toBe("pro");
  });

  it("con una cortesía viva, el plan efectivo la refleja", () => {
    const tenant = withEffectivePlan(
      row({ plan: "basico", plan_courtesy: "premium" }),
      NOW,
    );

    expect(tenant.plan).toBe("premium");
  });

  /**
   * Lo pagado tiene que sobrevivir intacto. Es lo que el panel de plataforma
   * compara contra la suscripción: si `paid_plan` trajera la cortesía, todo
   * negocio con un regalo aparecería como desacuerdo de planes.
   */
  it("conserva lo pagado aunque la cortesía lo tape", () => {
    const tenant = withEffectivePlan(
      row({ plan: "basico", plan_courtesy: "premium" }),
      NOW,
    );

    expect(tenant.paid_plan).toBe("basico");
  });

  /**
   * La fecha llega de PostgREST como TEXTO. Si no se convierte, la comparación
   * contra `now` se hace entre un string y un Date y la cortesía nunca vence:
   * el regalo queda puesto para siempre y nadie se entera.
   */
  it("interpreta el vencimiento que viene como texto", () => {
    const vencida = withEffectivePlan(
      row({
        plan: "basico",
        plan_courtesy: "premium",
        plan_courtesy_until: "2026-08-01T00:00:00Z",
      }),
      NOW,
    );
    const viva = withEffectivePlan(
      row({
        plan: "basico",
        plan_courtesy: "premium",
        plan_courtesy_until: "2026-12-01T00:00:00Z",
      }),
      NOW,
    );

    expect(vencida.plan).toBe("basico");
    expect(viva.plan).toBe("premium");
  });

  it("no pierde el resto de las columnas", () => {
    const tenant = withEffectivePlan(row({ plan_courtesy: "pro" }), NOW);

    expect(tenant.slug).toBe("acme");
    expect(tenant.brand_color).toBe("#e3b23c");
    expect(tenant.plan_courtesy).toBe("pro");
  });
});
