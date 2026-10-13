import "server-only";

import { z } from "zod";

import { appError, err, ok, type Result } from "@/core/result";

import { notifyToken } from "../domain/notify-token";
import { stateSecret } from "./config";

/**
 * Preferencia de Checkout Pro del turno, creada con el token DEL NEGOCIO: la
 * plata va de quien paga a la cuenta de Mercado Pago del negocio, sin pasar
 * por la plataforma. Mismo estilo que `mercadopago-oauth.ts`: fetch crudo,
 * timeout, sin caché y errores como Result con códigos estables.
 *
 * - `mp_unauthorized`: 401/403. Falla de la CUENTA (token revocado o sin
 *   permiso): reintentar no sirve y el negocio tiene que reconectar.
 * - `mp_rejected`: otro 4xx. Mercado Pago no aceptó ESTA preferencia.
 * - `mp_unreachable`: no contestó, tardó o devolvió 5xx. Transitorio.
 * - `mp_bad_response`: contestó 2xx pero sin una preferencia usable.
 *
 * Los mensajes de error no incluyen nada de la respuesta ni el token.
 */

const ENDPOINT = "https://api.mercadopago.com/checkout/preferences";
const TIMEOUT_MS = 10_000;

export interface CheckoutPreferenceInput {
  /** Nombre del servicio: lo que ve quien paga en el checkout. */
  title: string;
  amountCents: number;
  currency: string;
  bookingId: string;
  tenantId: string;
  slug: string;
  /** Origen de la app, sin barra final (`NEXT_PUBLIC_APP_URL`). */
  appUrl: string;
  /** Vence junto con el hold: pasado este instante no se puede pagar. */
  expiresAt: Date;
  payer: { name: string; email: string | null };
}

export interface CheckoutPreference {
  preferenceId: string;
  initPoint: string;
}

const responseSchema = z.object({
  id: z.string().min(1),
  init_point: z.url(),
});

const unauthorized = () =>
  err(
    appError(
      "mp_unauthorized",
      "Mercado Pago no aceptó la cuenta del negocio. Hay que volver a conectarla.",
    ),
  );

const rejected = () =>
  err(appError("mp_rejected", "Mercado Pago rechazó el pago. Intentá de nuevo."));

const unreachable = () =>
  err(
    appError(
      "mp_unreachable",
      "No pudimos comunicarnos con Mercado Pago. Intentá de nuevo en un momento.",
    ),
  );

const badResponse = () =>
  err(
    appError(
      "mp_bad_response",
      "Mercado Pago respondió algo que no esperábamos. Intentá de nuevo.",
    ),
  );

export async function createCheckoutPreference(
  accessToken: string,
  input: CheckoutPreferenceInput,
): Promise<Result<CheckoutPreference>> {
  // El token `k` ata la URL de notificación a este negocio (ver `notify-token`).
  // Sin el secreto no se crea la preferencia: saldría con una URL que el webhook
  // descarta, y el cobro quedaría sin confirmarse.
  const secret = stateSecret();
  if (!secret.ok) return secret;

  const returnUrl = `${input.appUrl}/${input.slug}/reserva/${input.bookingId}`;

  const payload = {
    items: [
      {
        title: input.title,
        quantity: 1,
        // Centavos enteros → número con 2 decimales. `toFixed` evita que
        // 1999 / 100 se arrastre como 19.990000000000002.
        unit_price: Number((input.amountCents / 100).toFixed(2)),
        currency_id: input.currency,
      },
    ],
    // El webhook vuelve a leer el pago y lo cruza con este id.
    external_reference: input.bookingId,
    notification_url: `${input.appUrl}/api/webhooks/mercadopago/payments?tenant=${encodeURIComponent(input.tenantId)}&k=${notifyToken(secret.value, input.tenantId)}`,
    back_urls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
    auto_return: "approved",
    // El pago termina aprobado o rechazado, nunca "en revisión".
    binary_mode: true,
    expires: true,
    expiration_date_to: input.expiresAt.toISOString(),
    // Sólo medios inmediatos: un ticket/ATM se paga horas después, con el hold ya vencido.
    payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] },
    payer: {
      name: input.payer.name,
      ...(input.payer.email ? { email: input.payer.email } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return unauthorized();
    return response.status >= 500 ? unreachable() : rejected();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return badResponse();
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) return badResponse();

  return ok({ preferenceId: parsed.data.id, initPoint: parsed.data.init_point });
}
