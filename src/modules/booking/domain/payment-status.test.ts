import { describe, expect, it } from "vitest";

import { describePaymentStatus } from "./payment-status";

describe("describePaymentStatus", () => {
  it.each([
    ["paid", "Pagado", "success"],
    ["awaiting", "Esperando pago", "gold"],
    ["refund_due", "Devolución pendiente", "danger"],
    ["refunded", "Devuelto", "muted"],
  ] as const)("%s se pinta como %s", (status, label, tone) => {
    expect(describePaymentStatus(status)).toEqual({ label, tone });
  });

  // Un turno que nunca pasó por cobro no lleva badge: el de siempre.
  it("no pinta nada para un turno que no requiere pago", () => {
    expect(describePaymentStatus("not_required")).toBeNull();
  });

  it("no rompe con un estado que la base sume antes que el front", () => {
    expect(describePaymentStatus("disputed" as never)).toBeNull();
  });
});
