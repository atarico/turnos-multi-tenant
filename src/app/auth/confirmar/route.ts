import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { NEW_PASSWORD_PATH } from "@/modules/auth/domain/reset-url";

/**
 * El portón que canjea el link del mail de recuperación por una sesión.
 *
 * Es la única ruta del proyecto que abre sesión SIN contraseña, y le pega
 * cualquiera: la URL viaja por mail, en texto plano, y se puede reescribir a
 * mano antes de abrirla. Todo lo que llega en la query es dato del atacante
 * hasta que se demuestre lo contrario, así que nada de la query se reenvía:
 * se compara contra lo que esperamos.
 *
 * `runtime = "nodejs"` explícito por la misma razón que el webhook de Mercado
 * Pago: dejarlo escrito hace que un cambio de default rompa el build y no la
 * recuperación de contraseña en producción.
 */
export const runtime = "nodejs";

/**
 * A dónde vuelve quien llegó con un link que ya no sirve.
 *
 * `link=vencido` es una bandera, no un mensaje: la pantalla la traduce. Que el
 * texto viva en la página y no en la URL evita que alguien mande un link con
 * el cartel que se le ocurra.
 */
const EXPIRED_LINK_DESTINATION = "/recuperar?link=vencido";

/**
 * El único `type` que esta ruta canjea.
 *
 * `verifyOtp` acepta varios (`signup`, `invite`, `magiclink`, `email_change`…)
 * y reenviarle el de la query convertiría esto en un canjeador universal de
 * tokens: cualquier link de Supabase entraría por acá y saldría con sesión
 * abierta, rumbo a un formulario que fija contraseña. Por eso se compara
 * contra este literal y lo que se le pasa a `verifyOtp` es este literal.
 */
const RECOVERY_TYPE = "recovery";

/**
 * Decide a dónde se puede mandar a alguien después de canjear el token.
 *
 * Acá vive la defensa contra el open redirect, y está escrita al revés de como
 * sale intuitivamente. Lo intuitivo es mirar la FORMA del string y rechazar
 * los prefijos peligrosos. No alcanza, y no es cuestión de agregar uno más:
 * el parser de URL de la plataforma normaliza la entrada antes de resolverla,
 * así que un string inofensivo a la vista termina en otro dominio.
 *
 *   "//evil.com"     → http://evil.com/   protocol-relative
 *   "/\\evil.com"     → http://evil.com/   la barra invertida vale como `/`
 *   "/\t/evil.com"   → http://evil.com/   el TAB se descarta y quedan dos `/`
 *   "/\n/evil.com"   → http://evil.com/   ídem con salto de línea y con CR
 *
 * Los tres últimos pasan cualquier chequeo de prefijo sobre el string crudo,
 * porque el `//` no existe hasta DESPUÉS de normalizar. Por eso acá no se
 * adivina la forma: se resuelve el destino igual que lo va a resolver el
 * redirect y se compara el origen resultante contra el nuestro. Se verifica el
 * resultado, no el aspecto — y eso tapa la clase entera, incluidos los casos
 * que a nadie se le ocurrieron todavía.
 *
 * Sale `pathname + search` y no la URL entera para no arrastrar credenciales,
 * host ni fragmento de vuelta al redirect.
 */
function safeNextPath(raw: string | null, base: string): string {
  if (!raw) return NEW_PASSWORD_PATH;

  let destino: URL;
  try {
    destino = new URL(raw, base);
  } catch {
    return NEW_PASSWORD_PATH;
  }

  if (destino.origin !== new URL(base).origin) return NEW_PASSWORD_PATH;
  return `${destino.pathname}${destino.search}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const next = safeNextPath(params.get("next"), request.url);

  const expired = () =>
    NextResponse.redirect(new URL(EXPIRED_LINK_DESTINATION, request.url));

  // Sin token, o con un `type` que no es el nuestro, no hay nada que canjear.
  // Sale por la misma puerta que el token vencido a propósito: contestar
  // distinto según qué falta le enseña a quien está probando qué le falta.
  if (!tokenHash || type !== RECOVERY_TYPE) return expired();

  const supabase = await createClient();

  // El `try` no es decorativo: `verifyOtp` sale a la red y puede TIRAR, no
  // sólo devolver `error`. Una excepción suelta acá es un 500, o sea una
  // pantalla rota para alguien que sólo quiere volver a entrar a su agenda.
  // Los links son de un solo uso y vencen: llegar con uno muerto es el caso
  // FRECUENTE, no la excepción, y tiene que terminar en una pantalla que
  // explique y ofrezca pedir otro.
  try {
    const { error } = await supabase.auth.verifyOtp({
      type: RECOVERY_TYPE,
      token_hash: tokenHash,
    });
    if (error) return expired();
  } catch {
    return expired();
  }

  // Sesión abierta. `next` ya pasó por `safeNextPath`, así que esto no puede
  // salir del sitio.
  return NextResponse.redirect(new URL(next, request.url));
}
