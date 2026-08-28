import { serverEnv } from "@/lib/env";
import { applyWebhookNotification } from "@/modules/billing/application/webhook";
import {
  diagnoseWebhookSignature,
  isValidWebhookSignature,
} from "@/modules/billing/domain/webhook-signature";

/**
 * El webhook de Mercado Pago. EL ÚNICO PORTÓN DEL PROYECTO ABIERTO A INTERNET.
 *
 * Acá le pega cualquiera: la URL se publica en el panel de Mercado Pago y no
 * hay sesión, ni cookie, ni negocio del otro lado. Lo único que separa una
 * notificación real de una inventada es la firma, y detrás de este archivo hay
 * una función que pone planes pagos. Por eso el orden no se negocia:
 *
 *   1. Firma. Antes de tocar la base, antes de todo.
 *   2. Recién ahí, el cuerpo.
 *
 * Y ni siquiera la firma alcanza para creerle al cuerpo: prueba que el AVISO
 * es de ellos, no que el JSON de adentro sea cierto. El estado real se le
 * pregunta a Mercado Pago en `applyWebhookNotification`.
 *
 * `runtime = "nodejs"` explícito: la verificación de firma usa `node:crypto`,
 * que en el runtime edge no existe. Hoy es el default de Next, y dejarlo
 * escrito es lo que hace que un cambio de default rompa el build en vez de
 * romper los cobros en producción.
 */
export const runtime = "nodejs";

/**
 * Códigos que NO mejoran reintentando.
 *
 * Todo lo demás pide reintento con un 5xx, que es la única forma de decirle a
 * Mercado Pago "todavía no". Un 200 sobre algo que falló le dice que ya está
 * resuelto y el cobro se pierde para siempre, así que el default es reintentar
 * y esta lista es la excepción corta.
 *
 * `mp_bad_response` es contrato roto: contestaron 2xx con algo inservible. Eso
 * lo arregla una persona mirando el log, no quince minutos de espera repetidos
 * indefinidamente.
 */
const NOT_RETRYABLE = new Set(["mp_bad_response"]);

/** Nada de cuerpo hacia afuera. Ver la nota en el `catch`. */
const respond = (status: number) => new Response(null, { status });

/**
 * TEMPORAL — DIAGNÓSTICO DEL SANDBOX. BORRAR CUANDO LA FIRMA VALIDE.
 *
 * Saca del cuerpo los ids que Mercado Pago PODRÍA haber firmado cuando el
 * query param `data.id` no viene en la URL, que es lo que hace el simulador
 * del panel. Si el manifiesto armado con alguno de estos valida, ese es el
 * diagnóstico y la corrección es leer el id del cuerpo como respaldo.
 */
function candidateIdsFromBody(raw: string): string[] {
  try {
    const body = JSON.parse(raw) as { id?: unknown; data?: { id?: unknown } };
    const ids = [body?.data?.id, body?.id];

    return ids
      .filter((id) => typeof id === "string" || typeof id === "number")
      .map((id) => String(id));
  } catch {
    return [];
  }
}

export async function POST(request: Request): Promise<Response> {
  // `serverEnv()` TIRA si falta la variable, y una excepción acá sería un 500.
  // Con el secreto sin configurar el portón tiene que quedar CERRADO —401— y
  // no abierto ni roto: `isValidWebhookSignature` ya devuelve false ante un
  // secreto vacío, así que alcanza con no dejar escapar la excepción.
  let secret = "";
  try {
    secret = serverEnv().MERCADOPAGO_WEBHOOK_SECRET;
  } catch {
    secret = "";
  }

  // `data.id` viaja en la QUERY de la URL de notificación, no en el cuerpo, y
  // es una de las tres cosas que la firma ata. Leerlo de otro lado hace que
  // todas las notificaciones legítimas se rechacen.
  const dataId = new URL(request.url).searchParams.get("data.id");

  // El cuerpo se LEE acá pero no se ACTÚA sobre él hasta después del portón.
  // Leerlo antes es sólo mover bytes; el orden que importa —no tocar la base
  // sin firma válida— sigue intacto más abajo. Un cuerpo ilegible no es motivo
  // para rechazar: eso lo decide la firma.
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    rawBody = "";
  }

  const signature = {
    signatureHeader: request.headers.get("x-signature"),
    requestId: request.headers.get("x-request-id"),
    dataId,
    secret,
    now: new Date(),
  };

  if (!isValidWebhookSignature(signature)) {
    // TEMPORAL — BORRAR JUNTO CON `candidateIdsFromBody` Y EL IMPORT DE
    // `diagnoseWebhookSignature`. El 401 de afuera no dice en qué paso frenó,
    // a propósito; esto lo dice del lado del servidor, en los logs de Vercel.
    // No registra el secreto: el manifiesto y un prefijo de hash no permiten
    // reconstruirlo.
    console.warn(
      "[mp-webhook] firma rechazada",
      JSON.stringify(
        diagnoseWebhookSignature(signature, candidateIdsFromBody(rawBody)),
      ),
    );

    return respond(401);
  }

  // Probó ser Mercado Pago. Recién ahora se interpreta el cuerpo.
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // La firma ya validó, o sea que esto vino de ellos con un cuerpo que no
    // podemos leer. 200 igual: un 4xx lo haría reintentar cada quince minutos
    // para siempre algo que no mejora con el tiempo.
    return respond(200);
  }

  try {
    const applied = await applyWebhookNotification(body);

    if (applied.ok) return respond(200);

    return respond(NOT_RETRYABLE.has(applied.error.code) ? 200 : 500);
  } catch {
    // Red de contención. Cualquier excepción que se escape río abajo se
    // convierte en un pedido de reintento en vez de en una pantalla de error
    // del framework: la operación es idempotente del lado de la base, así que
    // reintentar es seguro y perder el cobro no.
    //
    // Y no sale NADA en el cuerpo, ni acá ni en los otros caminos. El mensaje
    // de una excepción puede arrastrar el secreto o la URL de la base, y esta
    // respuesta la lee quien haya mandado la request — que puede ser
    // cualquiera. Mercado Pago sólo mira el código de estado.
    return respond(500);
  }
}
