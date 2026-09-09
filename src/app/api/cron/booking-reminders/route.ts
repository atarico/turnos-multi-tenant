import { createHash, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/lib/env";
import { sendDueReminders } from "@/modules/notifications/application/send-reminders";

/**
 * El endpoint que dispara los recordatorios del día siguiente.
 *
 * Lo llama el cron de Vercel una vez por día —ver `vercel.json`—, con GET y
 * con `Authorization: Bearer <CRON_SECRET>`. No lo llama nadie más, y ése es
 * todo el trabajo de este archivo: del otro lado hay un proceso que le escribe
 * a los clientes de TODOS los negocios, así que la URL sola no puede alcanzar
 * para dispararlo.
 *
 * A LAS 12 UTC, que son las 9 de la mañana en Argentina. Elegida para el país
 * donde está el producto: un recordatorio que llega a las 3 de la mañana no lo
 * lee nadie antes del turno. El plan gratuito de Vercel da UNA corrida diaria,
 * así que esto no puede ser "24 horas antes" exactas de cada turno — es "el
 * día antes, a la mañana". Para los turnos de mañana a primera hora eso son
 * casi 24 horas; para los de mañana a la noche, unas 34. Las dos sirven para
 * lo que el recordatorio hace, que es que la persona se acuerde y avise si no
 * va a venir.
 *
 * `dynamic = "force-dynamic"` porque esto NO se puede prerenderizar ni cachear:
 * es un efecto, no una lectura, y una respuesta cacheada convertiría la
 * segunda corrida en un no-op silencioso.
 */
export const dynamic = "force-dynamic";

const respond = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status });

/**
 * Compara dos secretos sin filtrar por dónde difieren.
 *
 * Se hashean los dos antes de comparar y no se comparan directo: `timingSafeEqual`
 * TIRA un RangeError ante buffers de largo distinto, y un token de largo
 * arbitrario es lo primero que manda alguien probando el endpoint. Pasar por
 * sha256 deja los dos lados en 32 bytes siempre, así que el largo del secreto
 * real tampoco se filtra por el camino del error.
 *
 * Es la misma lección que ya está escrita en `webhook-signature.ts`, resuelta
 * distinto porque allá los dos lados ya son hexadecimales y acá el secreto es
 * texto cualquiera.
 */
function secretMatches(expected: string, received: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  // `serverEnv()` TIRA si algo obligatorio falta, y una excepción acá sería un
  // 500 que el cron reintenta. Se lee adentro de un `try` por eso.
  let secret: string | undefined;
  try {
    secret = serverEnv().CRON_SECRET;
  } catch {
    return respond(500);
  }

  // SIN SECRETO EL PORTÓN QUEDA CERRADO, no abierto. Es la diferencia con las
  // variables del correo: ausentes, aquéllas apagan una función; ausente ésta,
  // cualquiera que descubra la URL dispara correos a los clientes de todos los
  // negocios. Un endpoint que no se puede autenticar no se abre.
  if (!secret) return respond(401);

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !secretMatches(secret, token)) return respond(401);

  // `sendDueReminders` no tira nunca, y de eso depende que un fallo no se
  // convierta en un 500 que el cron reintenta — reintentar volvería a mandar
  // todo lo que ya salió. El resumen viaja en la respuesta porque es lo único
  // que queda de la corrida: es lo que se lee en el log de Vercel cuando
  // alguien pregunta por qué un cliente no recibió su recordatorio.
  const summary = await sendDueReminders();

  return respond(200, summary);
}
