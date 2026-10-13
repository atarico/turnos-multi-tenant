import type { PaymentStatus } from "./types";

/** Cómo se pinta el estado de cobro de un turno: etiqueta + tono del Badge. */
export interface PaymentStatusDescriptor {
  label: string;
  tone: "gold" | "success" | "danger" | "info" | "muted";
}

const DESCRIPTORS: Partial<Record<PaymentStatus, PaymentStatusDescriptor>> = {
  paid: { label: "Pagado", tone: "success" },
  awaiting: { label: "Esperando pago", tone: "gold" },
  refund_due: { label: "Devolución pendiente", tone: "danger" },
  refunded: { label: "Devuelto", tone: "muted" },
};

/**
 * Traduce `payment_status` a badge. Devuelve `null` para 'not_required' (el
 * turno de siempre, sin cobro: no lleva badge) y para un valor que la base sume
 * antes que el front — ante la duda, no inventar una etiqueta.
 */
export function describePaymentStatus(
  status: PaymentStatus,
): PaymentStatusDescriptor | null {
  return DESCRIPTORS[status] ?? null;
}
