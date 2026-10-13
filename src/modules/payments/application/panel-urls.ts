import "server-only";

import { serverEnv } from "@/lib/env";

import type { PaymentsFlag } from "../domain/panel-flags";

/**
 * URLs absolutas del flujo de conexión, siempre sobre `NEXT_PUBLIC_APP_URL`.
 *
 * No se arman con `request.url`: detrás de un proxy puede traer el host
 * interno, y el `redirect_uri` tiene que ser EXACTAMENTE el registrado en la
 * aplicación de Mercado Pago.
 */

const base = () => serverEnv().NEXT_PUBLIC_APP_URL;

export const mpCallbackUrl = () => new URL("/api/payments/mp/callback", base()).toString();

/** La pantalla de pagos, con una bandera fija si hay algo que contar. */
export function paymentsPanelUrl(flag?: PaymentsFlag): URL {
  const url = new URL("/panel/pagos", base());
  if (flag) url.searchParams.set("mp", flag);
  return url;
}

export const loginUrl = () => new URL("/ingresar", base());
