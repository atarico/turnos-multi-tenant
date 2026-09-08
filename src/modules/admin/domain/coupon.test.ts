import { describe, expect, it } from "vitest";

import { couponState, discountLabel, type Coupon } from "./coupon";

const NOW = new Date("2026-08-31T12:00:00Z");

function coupon(over: Partial<Coupon> = {}): Coupon {
  return {
    code: "BETA99",
    discount_bps: 9900,
    active: true,
    expires_at: null,
    max_redemptions: null,
    redemptions: 0,
    note: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("couponState", () => {
  it("un cupón nuevo y sin límites está activo", () => {
    expect(couponState(coupon(), NOW)).toBe("active");
  });

  it("apagado", () => {
    expect(couponState(coupon({ active: false }), NOW)).toBe("off");
  });

  it("vencido", () => {
    expect(
      couponState(coupon({ expires_at: "2026-08-01T00:00:00Z" }), NOW),
    ).toBe("expired");
  });

  it("con vencimiento futuro sigue activo", () => {
    expect(
      couponState(coupon({ expires_at: "2026-12-01T00:00:00Z" }), NOW),
    ).toBe("active");
  });

  it("agotado al llegar al tope", () => {
    expect(
      couponState(coupon({ max_redemptions: 2, redemptions: 2 }), NOW),
    ).toBe("exhausted");
  });

  /** El borde: con uno menos que el tope todavía queda uno. */
  it("con un canje libre todavía está activo", () => {
    expect(
      couponState(coupon({ max_redemptions: 2, redemptions: 1 }), NOW),
    ).toBe("active");
  });

  it("sin tope no se agota nunca", () => {
    expect(
      couponState(coupon({ max_redemptions: null, redemptions: 999 }), NOW),
    ).toBe("active");
  });

  /**
   * `off` gana sobre los otros dos porque es el único que el operador puede
   * deshacer con un click. Decirle "vencido" a un cupón que él apagó lo manda a
   * cambiar una fecha que no cambia nada.
   */
  it("apagado gana sobre vencido y sobre agotado", () => {
    expect(
      couponState(
        coupon({
          active: false,
          expires_at: "2026-08-01T00:00:00Z",
          max_redemptions: 1,
          redemptions: 5,
        }),
        NOW,
      ),
    ).toBe("off");
  });
});

describe("discountLabel", () => {
  it("muestra porcentaje, no puntos básicos", () => {
    expect(discountLabel(9900)).toBe("99%");
    expect(discountLabel(5000)).toBe("50%");
  });

  /** Un descuento con fracción no se redondea a un número que nadie pactó. */
  it("conserva la fracción cuando la hay", () => {
    expect(discountLabel(1250)).toBe("12.50%");
  });
});
