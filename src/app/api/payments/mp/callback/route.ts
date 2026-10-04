import { NextResponse, type NextRequest } from "next/server";

import { encryptionKey, stateSecret } from "@/modules/payments/application/config";
import { exchangeCode } from "@/modules/payments/application/mercadopago-oauth";
import { saveTenantMpAccount } from "@/modules/payments/application/mp-accounts";
import { currentOwnerTenant } from "@/modules/payments/application/ownership";
import {
  loginUrl,
  mpCallbackUrl,
  paymentsPanelUrl,
} from "@/modules/payments/application/panel-urls";
import {
  CONNECT_COOKIE_NAME,
  CONNECT_COOKIE_PATH,
  openConnectCookie,
} from "@/modules/payments/domain/connect-cookie";
import { verifyState } from "@/modules/payments/domain/oauth";
import type { PaymentsFlag } from "@/modules/payments/domain/panel-flags";

/**
 * A donde vuelve Mercado Pago después de que el dueño autoriza (o niega).
 *
 * Es la única puerta por la que entra una cuenta de cobro a un negocio, así
 * que ANTES de canjear el `code` se verifica todo:
 *
 * 1. La sesión es del DUEÑO de un negocio.
 * 2. El `state` es nuestro y no venció (firma + 10 minutos).
 * 3. El nonce del `state` es el de la cookie de ESTE navegador: prueba que
 *    quien vuelve es quien arrancó. Sin esto, un `state` legítimo que le hagan
 *    abrir a otra persona conectaría la cuenta del atacante a su negocio.
 * 4. El negocio del `state` es el de la sesión.
 *
 * Nunca imprime ni loguea el `code` ni los tokens, y la respuesta jamás los
 * lleva: vuelve a `/panel/pagos` con una bandera fija. La cookie se borra en
 * TODA salida —éxito, error o cancelación—: es de un solo uso.
 *
 * `force-dynamic`: lee sesión y cookies; es un efecto, no una página.
 */
export const dynamic = "force-dynamic";

function finish(target: URL): NextResponse {
  const response = NextResponse.redirect(target);
  response.cookies.set(CONNECT_COOKIE_NAME, "", {
    path: CONNECT_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

const finishWith = (flag: PaymentsFlag) => finish(paymentsPanelUrl(flag));

export async function GET(request: NextRequest) {
  const owner = await currentOwnerTenant();
  if (!owner.ok) {
    return owner.error.code === "no_session"
      ? finish(loginUrl())
      : finishWith("sin-permiso");
  }

  const key = encryptionKey();
  const secret = stateSecret();
  if (!key.ok || !secret.ok) return finishWith("no-configurado");

  const params = request.nextUrl.searchParams;

  // Mercado Pago avisa con `error` cuando el dueño no autoriza. `access_denied`
  // es "dijo que no": no es una falla, es una decisión, y se cuenta distinto.
  const mpError = params.get("error");
  if (mpError) return finishWith(mpError === "access_denied" ? "cancelado" : "error");

  const code = params.get("code");
  const stateParam = params.get("state");
  if (!code || !stateParam) return finishWith("error");

  const state = verifyState(stateParam, secret.value, new Date());
  if (!state.ok) return finishWith("error");

  const cookie = openConnectCookie(
    request.cookies.get(CONNECT_COOKIE_NAME)?.value,
    key.value,
  );
  if (!cookie.ok || cookie.value.nonce !== state.value.nonce) return finishWith("error");

  if (state.value.tenantId !== owner.value.tenantId) return finishWith("error");

  const tokens = await exchangeCode({
    code,
    codeVerifier: cookie.value.verifier,
    redirectUri: mpCallbackUrl(),
  });
  if (!tokens.ok) {
    // Sólo el código de error: el mensaje y la respuesta de Mercado Pago no se loguean.
    console.error("[payments] code exchange failed:", tokens.error.code);
    return finishWith("error");
  }

  const saved = await saveTenantMpAccount(owner.value.tenantId, tokens.value);
  if (!saved.ok) {
    console.error("[payments] account save failed:", saved.error.code);
    return finishWith("error");
  }

  return finishWith("conectado");
}
