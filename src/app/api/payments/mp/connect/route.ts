import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { mpClientCredentials, encryptionKey, stateSecret } from "@/modules/payments/application/config";
import { currentOwnerTenant } from "@/modules/payments/application/ownership";
import {
  loginUrl,
  mpCallbackUrl,
  paymentsPanelUrl,
} from "@/modules/payments/application/panel-urls";
import {
  CONNECT_COOKIE_MAX_AGE_SECONDS,
  CONNECT_COOKIE_NAME,
  CONNECT_COOKIE_PATH,
  sealConnectCookie,
} from "@/modules/payments/domain/connect-cookie";
import { buildAuthorizationUrl, createPkcePair, signState } from "@/modules/payments/domain/oauth";

/**
 * Arranca la conexión de la cuenta de Mercado Pago del negocio.
 *
 * Es un GET porque es un link: el dueño llega desde un botón de
 * `/panel/pagos`. No cambia nada del negocio todavía (eso pasa en el callback,
 * con el `code` en la mano), así que un GET es aceptable; lo que sí tiene que
 * pasar es que SÓLO el dueño pueda arrancarlo.
 *
 * Qué ata el flujo al navegador que lo inició:
 * - `state`: firmado (HMAC), con negocio + nonce + hora. Prueba que lo emitimos.
 * - cookie `mp_connect`: httpOnly, cifrada, con el MISMO nonce y el verifier
 *   PKCE. El callback exige que coincidan; sin eso, un `state` válido que le
 *   hagan abrir a otra persona conectaría la cuenta del atacante.
 *
 * `force-dynamic`: depende de la sesión y planta una cookie; nunca se cachea.
 */
export const dynamic = "force-dynamic";

const redirectTo = (url: URL | string) => NextResponse.redirect(url);

export async function GET() {
  const owner = await currentOwnerTenant();
  if (!owner.ok) {
    return redirectTo(
      owner.error.code === "no_session" ? loginUrl() : paymentsPanelUrl("sin-permiso"),
    );
  }

  const credentials = mpClientCredentials();
  const key = encryptionKey();
  const secret = stateSecret();
  if (!credentials.ok || !key.ok || !secret.ok) {
    return redirectTo(paymentsPanelUrl("no-configurado"));
  }

  const nonce = randomBytes(16).toString("base64url");
  const pkce = createPkcePair();

  const sealed = sealConnectCookie({ nonce, verifier: pkce.verifier }, key.value);
  if (!sealed.ok) return redirectTo(paymentsPanelUrl("error"));

  const state = signState(
    { tenantId: owner.value.tenantId, nonce, issuedAt: new Date() },
    secret.value,
  );

  const response = redirectTo(
    buildAuthorizationUrl({
      clientId: credentials.value.clientId,
      redirectUri: mpCallbackUrl(),
      state,
      codeChallenge: pkce.challenge,
    }),
  );

  response.cookies.set(CONNECT_COOKIE_NAME, sealed.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax y no Strict: Mercado Pago vuelve con una navegación de primer nivel
    // desde otro sitio, y Strict no mandaría la cookie en esa vuelta.
    sameSite: "lax",
    path: CONNECT_COOKIE_PATH,
    maxAge: CONNECT_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
