import { appError, err, ok, type Result } from "@/core/result";

import { decryptToken, encryptToken } from "./token-crypto";

/**
 * La cookie que ata el callback de Mercado Pago al navegador que inició la
 * conexión.
 *
 * Lleva el `nonce` (que también viaja DENTRO del `state` firmado) y el
 * `verifier` PKCE. Sin ella, el `state` por sí solo prueba que lo firmamos
 * nosotros, pero no que quien vuelve es quien arrancó: un atacante podría
 * iniciar el flujo con su cuenta y hacer que la víctima abra el callback. Con
 * la cookie, el callback exige que el nonce del `state` coincida con el de ESTE
 * navegador.
 *
 * Va cifrada con la misma clave y el mismo sobre AES-GCM que los tokens: el
 * verifier es un secreto (con él y el `code` se canjea el token) y GCM además
 * autentica, así que una cookie tocada falla en vez de leerse a basura.
 */

export const CONNECT_COOKIE_NAME = "mp_connect";
/** Sólo viaja hacia los dos endpoints del flujo, no hacia el resto de la app. */
export const CONNECT_COOKIE_PATH = "/api/payments/mp";
/** Lo mismo que vive el `state`: 10 minutos. */
export const CONNECT_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export interface ConnectCookie {
  nonce: string;
  verifier: string;
}

const invalid = () =>
  err(appError("connect_cookie_invalid", "La sesión de conexión no es válida."));

export function sealConnectCookie(value: ConnectCookie, key: string): Result<string> {
  return encryptToken(JSON.stringify({ n: value.nonce, v: value.verifier }), key);
}

export function openConnectCookie(
  raw: string | undefined,
  key: string,
): Result<ConnectCookie> {
  if (!raw) return invalid();

  const decrypted = decryptToken(raw, key);
  if (!decrypted.ok) return invalid();

  try {
    const { n, v } = JSON.parse(decrypted.value) as { n?: unknown; v?: unknown };
    if (typeof n !== "string" || !n || typeof v !== "string" || !v) return invalid();
    return ok({ nonce: n, verifier: v });
  } catch {
    return invalid();
  }
}
