import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Limpieza de holds de pago vencidos (RPC `cancel_expired_payment_holds`).
 *
 * Es sólo prolijidad: un hold vencido ya no ocupa cupo en la base. Devuelve
 * cuántos canceló. Un error es un Result, no una excepción: el cron sigue con
 * la renovación de tokens aunque esto falle.
 */
export async function cancelExpiredPaymentHolds(): Promise<Result<number>> {
  try {
    const { data, error } = await createAdminClient().rpc("cancel_expired_payment_holds");
    if (error || typeof data !== "number") throw error ?? new Error("respuesta inesperada");
    return ok(data);
  } catch {
    return err(
      appError("hold_cleanup_failed", "No pudimos cancelar los holds de pago vencidos."),
    );
  }
}
