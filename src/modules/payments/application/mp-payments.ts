import "server-only";

import { z } from "zod";

import { appError, err, ok, type Result } from "@/core/result";

/**
 * Lectura de pagos de Mercado Pago con el token DEL NEGOCIO.
 *
 * El aviso (webhook) nunca es la fuente de verdad: sólo dice "mirá este pago".
 * El estado, el monto y a quién se le pagó se leen acá, de Mercado Pago. Mismo
 * estilo que `checkout-preference.ts`: fetch crudo, timeout, sin caché y
 * errores como Result con códigos estables:
 *
 * - `mp_unauthorized`: 401/403. El token no sirve (o el pago no es de esta
 *   cuenta). Reintentar no cambia nada.
 * - `mp_rate_limited`: 429. Transitorio: Mercado Pago pide esperar.
 * - `mp_rejected`: otro 4xx. Un 404 se distingue con `cause: "not_found"`: el
 *   pago no existe para esta cuenta.
 * - `mp_unreachable`: no contestó, tardó o devolvió 5xx. Transitorio.
 * - `mp_bad_response`: contestó 2xx pero con algo inservible.
 *
 * Los mensajes de error no incluyen nada de la respuesta ni el token.
 */

const BASE = "https://api.mercadopago.com/v1/payments";
const TIMEOUT_MS = 10_000;

/** El pago ya normalizado: lo único que el resto del módulo ve de Mercado Pago. */
export interface MpPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  /** Para nosotros, el id del turno. Se valida del lado de quien aplica. */
  externalReference: string | null;
  /** Centavos enteros: el float de Mercado Pago no se arrastra. */
  amountCents: number;
  currency: string;
  /** Id de la cuenta que cobró. Texto, igual que `tenant_mp_accounts.mp_user_id`. */
  collectorId: string | null;
  /** Cuándo se acreditó (ISO UTC), o null si no vino. Define si llegó a tiempo. */
  approvedAt: string | null;
}

const idish = z.union([z.number(), z.string().min(1)]);

const paymentSchema = z.object({
  id: idish,
  status: z.string().min(1),
  status_detail: z.string().nullish(),
  external_reference: z.string().nullish(),
  transaction_amount: z.number().finite(),
  currency_id: z.string().min(1),
  // Según el endpoint llega plano o anidado: se aceptan las dos formas.
  collector_id: idish.nullish(),
  collector: z.object({ id: idish.nullish() }).nullish(),
  date_approved: z.string().nullish(),
});

const searchSchema = z.object({ results: z.array(paymentSchema) });

type RawPayment = z.infer<typeof paymentSchema>;

/** ISO UTC, o null si no es una fecha: un `date_approved` roto no tira el pago entero. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function normalize(raw: RawPayment): MpPayment {
  const collector = raw.collector_id ?? raw.collector?.id ?? null;
  return {
    id: String(raw.id),
    status: raw.status,
    statusDetail: raw.status_detail ?? null,
    externalReference: raw.external_reference ? raw.external_reference : null,
    amountCents: Math.round(raw.transaction_amount * 100),
    currency: raw.currency_id,
    collectorId: collector === null ? null : String(collector),
    approvedAt: isoOrNull(raw.date_approved),
  };
}

const unauthorized = () =>
  err(
    appError(
      "mp_unauthorized",
      "Mercado Pago no aceptó la cuenta del negocio. Hay que volver a conectarla.",
    ),
  );

const rateLimited = () =>
  err(
    appError(
      "mp_rate_limited",
      "Mercado Pago pidió esperar un momento. Intentá de nuevo en un rato.",
    ),
  );

const rejected = (cause?: "not_found") =>
  err(appError("mp_rejected", "Mercado Pago rechazó la consulta del pago.", cause));

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

/** GET autenticado + clasificación de errores. Devuelve el JSON crudo. */
async function get(
  accessToken: string,
  url: string,
  timeoutMs: number,
): Promise<Result<unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return unauthorized();
    if (response.status === 404) return rejected("not_found");
    if (response.status === 429) return rateLimited();
    return response.status >= 500 ? unreachable() : rejected();
  }

  try {
    return ok(await response.json());
  } catch {
    return badResponse();
  }
}

export async function fetchPayment(
  accessToken: string,
  paymentId: string,
): Promise<Result<MpPayment>> {
  // El id viene del aviso, o sea de quien sea: escapado para que no pueda
  // cambiar el path ni agregar parámetros.
  const body = await get(accessToken, `${BASE}/${encodeURIComponent(paymentId)}`, TIMEOUT_MS);
  if (!body.ok) return body;

  const parsed = paymentSchema.safeParse(body.value);
  if (!parsed.success) return badResponse();

  return ok(normalize(parsed.data));
}

/** Pagos de un turno, del más reciente al más viejo (el orden que da Mercado Pago). */
export async function searchPaymentsByExternalReference(
  accessToken: string,
  externalReference: string,
  options: { timeoutMs?: number } = {},
): Promise<Result<MpPayment[]>> {
  const query = new URLSearchParams({
    external_reference: externalReference,
    sort: "date_created",
    criteria: "desc",
  });
  const body = await get(
    accessToken,
    `${BASE}/search?${query.toString()}`,
    options.timeoutMs ?? TIMEOUT_MS,
  );
  if (!body.ok) return body;

  const parsed = searchSchema.safeParse(body.value);
  if (!parsed.success) return badResponse();

  return ok(parsed.data.results.map(normalize));
}
