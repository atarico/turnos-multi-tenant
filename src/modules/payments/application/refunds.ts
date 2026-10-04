import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

/**
 * Un pago que el dueño todavía tiene que devolver desde su cuenta de Mercado
 * Pago.
 *
 *   · `extra`: plata que entró y el turno no pedía (cobro doble, o un pago
 *     sobre un turno ya cancelado): la fila de `booking_payments` quedó
 *     'refund_due' y el turno no cambia.
 *   · `primary`: el pago que PAGÓ un turno que después se canceló: la fila
 *     sigue 'approved' y es el TURNO el que está 'refund_due'.
 */
export interface PaymentToRefund {
  /** `booking_payments.id`: lo que recibe `mark_payment_refunded`. */
  id: string;
  bookingId: string;
  customerName: string;
  /** Instante ISO (UTC) del turno. */
  startsAt: string;
  amountCents: number;
  currency: string;
  /** Con él el dueño ubica el cobro en Mercado Pago; puede faltar si MP no lo informó. */
  mpPaymentId: string | null;
  kind: "extra" | "primary";
}

interface RefundRow {
  id: string;
  booking_id: string;
  mp_payment_id: string | null;
  amount_cents: number;
  currency: string;
  bookings: { customer_name: string; starts_at: string };
}

const COLUMNS =
  "id, booking_id, mp_payment_id, amount_cents, currency, bookings!inner(customer_name, starts_at)";

const toRefund =
  (kind: PaymentToRefund["kind"]) =>
  (r: RefundRow): PaymentToRefund => ({
    id: r.id,
    bookingId: r.booking_id,
    customerName: r.bookings.customer_name,
    startsAt: r.bookings.starts_at,
    amountCents: r.amount_cents,
    currency: r.currency,
    mpPaymentId: r.mp_payment_id,
    kind,
  });

/**
 * Los pagos a devolver del negocio, el turno más próximo primero.
 *
 * Con la sesión (RLS deja a un miembro leer `booking_payments` y `bookings` de
 * su negocio); el `tenant_id` explícito es defensa en profundidad. Dos
 * consultas y no una: las filas 'approved' son TODAS las de turnos pagados, y
 * traerlas para filtrar en JS toparía con `max_rows` (1000) de PostgREST, que
 * recorta sin devolver error. El filtro del turno va en la base, sobre el embed
 * `!inner`. Si CUALQUIERA falla, falla todo: una lista parcial le haría creer
 * al dueño que no debe nada.
 */
export async function listPaymentsToRefund(
  tenantId: string,
): Promise<Result<PaymentToRefund[]>> {
  try {
    const supabase = await createClient();

    const extra = await supabase
      .from("booking_payments")
      .select(COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("status", "refund_due");
    if (extra.error) throw extra.error;

    const primary = await supabase
      .from("booking_payments")
      .select(COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("status", "approved")
      .eq("bookings.payment_status", "refund_due");
    if (primary.error) throw primary.error;

    const all = [
      ...((extra.data as unknown as RefundRow[] | null) ?? []).map(toRefund("extra")),
      ...((primary.data as unknown as RefundRow[] | null) ?? []).map(toRefund("primary")),
    ];
    all.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return ok(all);
  } catch {
    return err(appError("refunds_query_failed", "No pudimos leer los pagos a devolver."));
  }
}
