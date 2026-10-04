import { z } from "zod";

import { loadTenantAccessToken } from "@/modules/payments/application/mp-accounts";
import { stateSecret } from "@/modules/payments/application/config";
import { fetchPayment } from "@/modules/payments/application/mp-payments";
import { applyMpPayment } from "@/modules/payments/application/sync-booking-payment";
import { verifyNotifyToken } from "@/modules/payments/domain/notify-token";

/**
 * El webhook de pagos de los NEGOCIOS. Distinto de `../route.ts`, que es el de
 * la plataforma (suscripciones): acá Mercado Pago avisa que un cliente pagó un
 * turno en la cuenta de un negocio. La URL con `?tenant=<id>&k=<token>` la arma
 * `checkout-preference.ts` al crear la preferencia.
 *
 * También le pega cualquiera. Las anclas de confianza son DOS, y la firma
 * `x-signature` no es ninguna:
 *
 *   1. El token `k`: ata la URL a un negocio con un secreto del servidor. Se
 *      verifica ANTES de leer el cuerpo y de tocar la base o Mercado Pago, así
 *      que un anónimo sin él no hace trabajar a nadie. Falta o está mal: 200 y
 *      listo (un 4xx sólo invita a reintentar o a sondear).
 *   2. El re-fetch: lo que dice el aviso se descarta y el pago se vuelve a leer
 *      con el token del negocio. `applyMpPayment` exige además que el cobrador
 *      sea el negocio y que la referencia sea un turno suyo, y aplicar es
 *      idempotente, así que reproducir un aviso no hace nada.
 *
 * La firma NO se usa porque no está claro que Mercado Pago firme las URLs por
 * preferencia (ver el diseño de T5): un 401 podría tirar avisos legítimos, y
 * como `k` y el re-fetch ya cubren el abuso, no suma nada que valga ese riesgo.
 *
 * Tampoco se atiende `mp-connect` (el vendedor desvinculó la app): la firma no
 * ata ni el tipo ni el `user_id` del cuerpo, así que un aviso firmado repetido
 * podría romper la cuenta de cualquiera, y ese aviso probablemente llega sólo a
 * la URL a nivel aplicación. Una cuenta desvinculada se detecta cuando falla la
 * renovación del token (T6). Acá se responde 200 y se ignora, como a cualquier
 * tipo desconocido.
 *
 * `runtime = "nodejs"` explícito por `node:crypto` (el token `k`).
 */
export const runtime = "nodejs";

/** Nada de cuerpo hacia afuera: el mensaje de una excepción puede arrastrar secretos. */
const respond = (status: number) => new Response(null, { status });

const uuid = z.uuid();

/**
 * Códigos de `loadTenantAccessToken` que no mejoran reintentando: el negocio
 * tiene que reconectar (o el deploy no tiene pagos configurados). Todo lo demás
 * pide reintento: reintentar de más cuesta invocaciones, de menos cuesta el
 * cobro de un cliente.
 */
const ACCOUNT_UNUSABLE = new Set(["not_connected", "broken", "decrypt_failed", "payments_not_configured"]);

/**
 * Qué del re-fetch pide reintento (500). Un 404 también: Mercado Pago puede
 * avisar antes de que el pago sea legible, y el reintento es lo que lo arregla.
 * Un 401/403 NO (200): con un token perfecto, pedir un pago ajeno da 403, y
 * tampoco se marca la cuenta como rota por eso, porque el `data.id` lo elige
 * quien manda el aviso. Lo demás (otro 4xx, respuesta rota) devuelve lo mismo
 * siempre.
 */
function fetchShouldRetry(error: { code: string; cause?: unknown }): boolean {
  if (error.code === "mp_unreachable" || error.code === "mp_rate_limited") return true;
  return error.code === "mp_rejected" && error.cause === "not_found";
}

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function logSkipped(what: string, code: string, retry: boolean) {
  // Sólo el CÓDIGO (lista cerrada nuestra): ni el mensaje, ni el token.
  console.error(`[mp-payments-webhook] ${what}: ${code}${retry ? " — se pide reintento" : ""}`);
}

export async function POST(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const tenant = query.get("tenant");

  // PRIMERO el token: antes del cuerpo, de la base y de Mercado Pago.
  const secret = stateSecret();
  if (!secret.ok || !tenant || !verifyNotifyToken(secret.value, tenant, query.get("k"))) {
    return respond(200);
  }

  // El cuerpo no autentica nada, pero hay avisos que traen ahí el tipo o el id.
  // Ilegible no es un error: se decide con la query.
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(await request.json());
  } catch {
    body = {};
  }

  const type = asText(query.get("type")) ?? asText(query.get("topic")) ?? asText(body.type) ?? asText(body.topic);
  // El `id` del cuerpo es el de la NOTIFICACIÓN, no el del pago: no se usa.
  const paymentId =
    asText(query.get("data.id")) ?? asText(query.get("id")) ?? asText(asRecord(body.data).id);

  try {
    if (type === "payment") return await handlePayment(tenant, paymentId);
    return respond(200);
  } catch {
    // Red de contención: aplicar es idempotente, así que reintentar es seguro y
    // perder el cobro no. Sin cuerpo, a propósito.
    return respond(500);
  }
}

async function handlePayment(tenant: string, paymentId: string | null): Promise<Response> {
  // Sin uuid de negocio o sin pago no hay nada que hacer, ni mejora reintentando.
  if (!uuid.safeParse(tenant).success || !paymentId) return respond(200);

  const token = await loadTenantAccessToken(tenant);
  if (!token.ok) {
    const retry = !ACCOUNT_UNUSABLE.has(token.error.code);
    logSkipped("sin cuenta usable", token.error.code, retry);
    return respond(retry ? 500 : 200);
  }

  const fetched = await fetchPayment(token.value, paymentId);
  if (!fetched.ok) {
    const retry = fetchShouldRetry(fetched.error);
    logSkipped("no se pudo leer el pago", fetched.error.code, retry);
    return respond(retry ? 500 : 200);
  }

  const applied = await applyMpPayment(tenant, fetched.value);
  if (!applied.ok) {
    logSkipped("no aplicado", applied.error.code, true);
    return respond(500);
  }

  return respond(200);
}
