import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { createCheckoutPreference } from "./checkout-preference";
import { loadTenantAccessToken, markTenantMpAccountBroken } from "./mp-accounts";

/**
 * Arranca el pago de un turno que quedó en HOLD (`pending` + `awaiting`).
 *
 * La política de fallas es lo que importa de este archivo, y viene de dos
 * reglas de producto que chocan si no se separan:
 *
 *  - FALLA DE LA CUENTA del negocio (nunca conectó, conexión rota, token
 *    ilegible, o Mercado Pago contestó 401/403): el negocio sigue tomando
 *    turnos SIN pago hasta que reconecte. Se marca la cuenta rota (así
 *    `tenant_requires_payment` deja de exigir pago para los próximos) y ESTE
 *    hold se confirma sin cobro.
 *  - FALLA TRANSITORIA (Mercado Pago caído, red, respuesta rara, o algo
 *    nuestro): que Mercado Pago se caiga NO puede volver gratis el turno. Se
 *    cancela el hold y el cliente reintenta.
 *
 * Los dos caminos resuelven el hold con funciones service-role de la base
 * (`release_payment_hold_without_payment`, `cancel_payment_hold`), que
 * revalidan el estado adentro: este código no confirma ni cancela con un
 * UPDATE propio.
 *
 * Todo vuelve como Result y `createAdminClient()` está DENTRO de cada `try`:
 * tira si falta la service-role key, y una excepción acá dejaría un hold
 * colgado con el cliente mirando un error. Nada de lo que se loguea o devuelve
 * lleva el token.
 */

/** Lo que de la fila de `create_public_booking` hace falta para cobrar. */
export interface HeldBooking {
  id: string;
  tenant_id: string;
  service_name: string;
  price_cents: number;
  currency: string;
  customer_name: string;
  customer_email: string | null;
  payment_expires_at: string | null;
}

export interface StartPaymentContext {
  slug: string;
}

export type StartPaymentOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "confirmed_without_payment" };

/** Códigos de `loadTenantAccessToken` / `createCheckoutPreference` que son de la CUENTA. */
const ACCOUNT_LEVEL_CODES = new Set(["not_connected", "broken", "decrypt_failed", "mp_unauthorized"]);

const startFailed = () =>
  err(
    appError(
      "payment_start_failed",
      "No pudimos iniciar el pago, probá de nuevo en un momento.",
    ),
  );

async function resolveHold(
  fn: "release_payment_hold_without_payment" | "cancel_payment_hold",
  bookingId: string,
): Promise<boolean> {
  try {
    const { error } = await createAdminClient().rpc(fn, { p_booking_id: bookingId });
    return !error;
  } catch {
    return false;
  }
}

/** Falla transitoria: el hold se cancela. Si ni eso se puede, vence solo a los 15 min. */
async function cancelAndAskRetry(bookingId: string): Promise<Result<StartPaymentOutcome>> {
  await resolveHold("cancel_payment_hold", bookingId);
  return startFailed();
}

async function confirmWithoutPayment(
  booking: HeldBooking,
): Promise<Result<StartPaymentOutcome>> {
  // Si marcar la cuenta falla igual se confirma: el próximo cliente repetirá
  // el camino, y bloquear a ESTE por un error de bookkeeping no ayuda a nadie.
  await markTenantMpAccountBroken(booking.tenant_id);

  const released = await resolveHold("release_payment_hold_without_payment", booking.id);
  // No se pudo confirmar (p. ej. el hold venció mientras tanto): el turno no
  // puede quedar a medias, así que se cancela y el cliente reintenta.
  if (!released) return cancelAndAskRetry(booking.id);
  return ok({ kind: "confirmed_without_payment" });
}

function appUrl(): string | null {
  try {
    return serverEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function startBookingPayment(
  booking: HeldBooking,
  context: StartPaymentContext,
): Promise<Result<StartPaymentOutcome>> {
  const expiresAt = booking.payment_expires_at ? new Date(booking.payment_expires_at) : null;
  const origin = appUrl();
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || !origin) {
    return cancelAndAskRetry(booking.id);
  }

  const token = await loadTenantAccessToken(booking.tenant_id);
  if (!token.ok) {
    return ACCOUNT_LEVEL_CODES.has(token.error.code)
      ? confirmWithoutPayment(booking)
      : cancelAndAskRetry(booking.id);
  }

  const preference = await createCheckoutPreference(token.value, {
    title: booking.service_name,
    amountCents: booking.price_cents,
    currency: booking.currency,
    bookingId: booking.id,
    tenantId: booking.tenant_id,
    slug: context.slug,
    appUrl: origin,
    expiresAt,
    payer: { name: booking.customer_name, email: booking.customer_email },
  });
  if (!preference.ok) {
    return ACCOUNT_LEVEL_CODES.has(preference.error.code)
      ? confirmWithoutPayment(booking)
      : cancelAndAskRetry(booking.id);
  }

  // El pago se registra ANTES de devolver la URL: si no se puede, el cliente
  // nunca la recibe y el hold se cancela, en vez de dejarlo pagar algo que el
  // webhook no sabría a qué turno aplicar.
  try {
    const { error } = await createAdminClient().from("booking_payments").insert({
      booking_id: booking.id,
      tenant_id: booking.tenant_id,
      mp_preference_id: preference.value.preferenceId,
      status: "pending",
      amount_cents: booking.price_cents,
      currency: booking.currency,
    });
    if (error) return cancelAndAskRetry(booking.id);
  } catch {
    return cancelAndAskRetry(booking.id);
  }

  return ok({ kind: "redirect", url: preference.value.initPoint });
}
