import "server-only";

import { z } from "zod";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

import { RETURN_SYNC_BUDGET_MS } from "../domain/return-state";
import { loadTenantAccessToken } from "./mp-accounts";
import { searchPaymentsByExternalReference, type MpPayment } from "./mp-payments";

/**
 * Aplica un pago de Mercado Pago sobre el turno. Es UNA sola función para los
 * dos caminos —el webhook y el retorno del checkout—: si hubiera dos, tarde o
 * temprano discreparían sobre qué es un pago válido.
 *
 * NO AUTENTICA EL AVISO: recibe un pago que quien llama ya leyó de Mercado
 * Pago con el token del negocio. Lo que sí revisa es que ese pago sea de ESTE
 * negocio (`collector_id` contra el `mp_user_id` guardado) y que su
 * `external_reference` sea un id de turno; que el turno sea del negocio, el
 * monto y el estado del hold los decide `apply_booking_payment` adentro de la
 * transacción.
 *
 * Todo vuelve como Result y `createAdminClient()` está DENTRO de cada `try`
 * (tira si falta la service-role key). Un `err` significa "no se pudo, puede
 * valer reintentar"; lo que no corresponde aplicar es `ok("ignored")`. Nada de
 * lo que se devuelve lleva el token ni el error crudo de la base.
 */

export type ApplyOutcome = "applied" | "duplicate" | "ignored";

const OUTCOMES: ReadonlySet<string> = new Set<ApplyOutcome>(["applied", "duplicate", "ignored"]);

const idSchema = z.uuid();

const ignored = () => ok<ApplyOutcome>("ignored");

const accountLoadFailed = () =>
  err(appError("account_load_failed", "No pudimos leer la conexión con Mercado Pago."));

const applyFailed = () =>
  err(appError("payment_apply_failed", "No pudimos aplicar el pago. Intentá de nuevo."));

export async function applyMpPayment(
  tenantId: string,
  payment: MpPayment,
): Promise<Result<ApplyOutcome>> {
  // La referencia es lo único que ata el pago a un turno. Sin un uuid no hay
  // turno posible, y no se manda a la base algo que no lo es.
  if (!payment.externalReference || !idSchema.safeParse(payment.externalReference).success) {
    return ignored();
  }

  try {
    const admin = createAdminClient();

    const { data: account, error: accountError } = await admin
      .from("tenant_mp_accounts")
      .select("mp_user_id")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (accountError) return accountLoadFailed();

    // Un pago cobrado por otra cuenta no es de este negocio, aunque la
    // referencia apunte a uno de sus turnos. Sin collector no se puede
    // comprobar: se falla cerrado.
    const mpUserId = (account as { mp_user_id: string } | null)?.mp_user_id;
    if (!mpUserId || payment.collectorId === null || payment.collectorId !== mpUserId) {
      return ignored();
    }

    const { data, error } = await admin.rpc("apply_booking_payment", {
      p_tenant_id: tenantId,
      p_booking_id: payment.externalReference,
      p_mp_payment_id: payment.id,
      p_status: payment.status,
      p_amount_cents: payment.amountCents,
      p_currency: payment.currency,
      // Cuándo se acreditó: define si el pago llegó dentro de la ventana del
      // hold aunque se procese tarde. Null = la base lo toma como "ahora".
      p_approved_at: payment.approvedAt,
    });
    if (error) return applyFailed();

    // Un valor que la función no devuelve es un bug nuestro: no se da por bueno.
    if (typeof data !== "string" || !OUTCOMES.has(data)) return applyFailed();
    return ok(data as ApplyOutcome);
  } catch {
    // `createAdminClient()` o la red de la base: no se sabe en qué paso fue.
    return accountLoadFailed();
  }
}

/**
 * Sincroniza el turno al volver del checkout: busca los pagos con ese
 * `external_reference` y aplica el más reciente. Así el cliente ve
 * "confirmado" aunque el webhook todavía no haya llegado; si llega después, el
 * RPC lo reconoce como `duplicate`.
 */
export async function syncBookingPaymentFromReturn(
  tenantId: string,
  bookingId: string,
  options: { timeoutMs?: number } = {},
): Promise<Result<ApplyOutcome>> {
  if (!idSchema.safeParse(bookingId).success) return ignored();

  const token = await loadTenantAccessToken(tenantId);
  if (!token.ok) return token;

  const found = await searchPaymentsByExternalReference(token.value, bookingId, {
    timeoutMs: options.timeoutMs ?? RETURN_SYNC_BUDGET_MS,
  });
  if (!found.ok) return found;

  const latest = found.value[0];
  // Se vuelve a comprobar que sea de ESTE turno: la búsqueda filtra por
  // referencia, pero aplicar algo que no lo es no debería depender de eso.
  if (!latest || latest.externalReference !== bookingId) return ignored();

  return applyMpPayment(tenantId, latest);
}
