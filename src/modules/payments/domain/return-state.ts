/**
 * Qué le decimos a quien vuelve de Mercado Pago (o abre el link más tarde).
 *
 * Se decide SÓLO con lo que dice nuestra base sobre el turno: lo que traiga la
 * URL de retorno (`status`, `payment_id`, …) lo puede escribir cualquiera y
 * nunca entra acá.
 *
 * - `awaiting`: hold vigente, esperando que el pago se acredite.
 * - `confirmed`: el turno está confirmado.
 * - `released`: el pago no se completó y el turno se liberó. Un hold VENCIDO
 *   cuenta como liberado aunque nadie lo haya cancelado todavía (la limpieza
 *   por cron es posterior): ya no ocupa cupo, así que decir "estamos
 *   confirmando tu pago" sería una espera que no termina nunca.
 * - `other`: cualquier otro estado; no se inventa un mensaje de pago.
 */
export type ReturnState = "awaiting" | "confirmed" | "released" | "other";

export interface ReturnBookingFacts {
  status: string;
  paymentStatus: string;
  paymentExpiresAt: string | null;
}

export function returnState(facts: ReturnBookingFacts, now: Date): ReturnState {
  if (facts.status === "cancelled") return "released";
  if (facts.status === "confirmed") return "confirmed";

  if (facts.status === "pending" && facts.paymentStatus === "awaiting") {
    const expires = facts.paymentExpiresAt ? new Date(facts.paymentExpiresAt) : null;
    const live = expires !== null && !Number.isNaN(expires.getTime()) && expires > now;
    return live ? "awaiting" : "released";
  }

  return "other";
}
