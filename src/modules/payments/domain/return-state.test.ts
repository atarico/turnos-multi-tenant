import { describe, expect, it } from "vitest";

import { returnState } from "./return-state";

const NOW = new Date("2026-10-04T12:00:00Z");
const FUTURE = "2026-10-04T12:10:00Z";
const PAST = "2026-10-04T11:59:00Z";

describe("returnState", () => {
  it("un hold vigente está confirmando el pago", () => {
    expect(returnState({ status: "pending", paymentStatus: "awaiting", paymentExpiresAt: FUTURE }, NOW)).toBe("awaiting");
  });

  it("un hold VENCIDO ya no espera: el turno se liberó", () => {
    expect(returnState({ status: "pending", paymentStatus: "awaiting", paymentExpiresAt: PAST }, NOW)).toBe("released");
  });

  it("un hold sin vencimiento (dato roto) se trata como liberado, no como espera eterna", () => {
    expect(returnState({ status: "pending", paymentStatus: "awaiting", paymentExpiresAt: null }, NOW)).toBe("released");
  });

  it("un hold cancelado es liberado", () => {
    expect(returnState({ status: "cancelled", paymentStatus: "awaiting", paymentExpiresAt: FUTURE }, NOW)).toBe("released");
  });

  it("confirmado es confirmado, pagado o sin pago", () => {
    expect(returnState({ status: "confirmed", paymentStatus: "paid", paymentExpiresAt: null }, NOW)).toBe("confirmed");
    expect(returnState({ status: "confirmed", paymentStatus: "not_required", paymentExpiresAt: null }, NOW)).toBe("confirmed");
  });

  it("cualquier otro estado es 'other' (no se inventa un mensaje de pago)", () => {
    expect(returnState({ status: "completed", paymentStatus: "paid", paymentExpiresAt: null }, NOW)).toBe("other");
    expect(returnState({ status: "pending", paymentStatus: "not_required", paymentExpiresAt: null }, NOW)).toBe("other");
  });
});
