import "server-only";

import { z } from "zod";

import { appError, err, ok, type Result } from "@/core/result";

import { tokenExpiresAt } from "../domain/oauth";
import { mpClientCredentials } from "./config";

/**
 * Adaptador del OAuth de Mercado Pago: canje del `code` y renovación de
 * tokens. Mismo estilo que `billing/application/mercadopago.ts`: fetch crudo,
 * timeout, sin caché y errores como Result con códigos estables.
 *
 * - `mp_unreachable`: no contestó, tardó o devolvió 5xx. Transitorio.
 * - `mp_rejected`: contestó 4xx. Reintentar igual no sirve: el `code` ya se
 *   usó o venció, o el refresh token fue revocado (el negocio desvinculó la app).
 * - `mp_bad_response`: contestó 2xx pero con algo que no es un token usable.
 * - `payments_not_configured`: falta el client id o el secret.
 *
 * Los mensajes de error no incluyen nada de la respuesta: lleva tokens.
 */

const TOKEN_ENDPOINT = "https://api.mercadopago.com/oauth/token";
const TIMEOUT_MS = 10_000;

export interface MpTokens {
  accessToken: string;
  /** Cada renovación ROTA el refresh token: el nuevo reemplaza al anterior. */
  refreshToken: string;
  expiresAt: Date;
  mpUserId: number;
  publicKey: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  user_id: z.number().int().positive(),
  public_key: z.string().min(1),
});

const unreachable = () =>
  err(
    appError(
      "mp_unreachable",
      "No pudimos comunicarnos con Mercado Pago. Intentá de nuevo en un momento.",
    ),
  );

const rejected = () =>
  err(
    appError(
      "mp_rejected",
      "Mercado Pago rechazó la autorización. Volvé a conectar la cuenta.",
    ),
  );

const badResponse = () =>
  err(
    appError(
      "mp_bad_response",
      "Mercado Pago respondió algo que no esperábamos. Intentá de nuevo.",
    ),
  );

async function requestTokens(
  payload: Record<string, string>,
  now: Date,
): Promise<Result<MpTokens>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Un código de un solo uso y tokens que rotan: una respuesta cacheada
      // devolvería credenciales que ya no valen.
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }

  if (!response.ok) {
    return response.status >= 500 ? unreachable() : rejected();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return badResponse();
  }

  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) return badResponse();

  const t = parsed.data;
  return ok({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: tokenExpiresAt(now, t.expires_in),
    mpUserId: t.user_id,
    publicKey: t.public_key,
  });
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export async function exchangeCode(
  input: ExchangeCodeInput,
  now: Date = new Date(),
): Promise<Result<MpTokens>> {
  const credentials = mpClientCredentials();
  if (!credentials.ok) return credentials;

  return requestTokens(
    {
      client_id: credentials.value.clientId,
      client_secret: credentials.value.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    },
    now,
  );
}

/**
 * Renueva los tokens. Quien llama DEBE guardar el `refreshToken` devuelto: el
 * anterior queda inválido, y perder el nuevo deja al negocio desconectado.
 */
export async function refreshTokens(
  refreshToken: string,
  now: Date = new Date(),
): Promise<Result<MpTokens>> {
  const credentials = mpClientCredentials();
  if (!credentials.ok) return credentials;

  return requestTokens(
    {
      client_id: credentials.value.clientId,
      client_secret: credentials.value.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    now,
  );
}
