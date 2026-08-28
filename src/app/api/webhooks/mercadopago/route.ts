import { serverEnv } from "@/lib/env";
import { applyWebhookNotification } from "@/modules/billing/application/webhook";
import { isValidWebhookSignature } from "@/modules/billing/domain/webhook-signature";

/**
 * El webhook de Mercado Pago. EL ÚNICO PORTÓN DEL PROYECTO ABIERTO A INTERNET.
 *
 * Acá le pega cualquiera: la URL se publica en el panel de Mercado Pago y no
 * hay sesión, ni cookie, ni negocio del otro lado. Lo único que separa una
 * notificación real de una inventada es la firma, y detrás de este archivo hay
 * una función que pone planes pagos. Por eso el orden no se negocia:
 *
 *   1. Firma. Antes de leer el cuerpo, antes de tocar la base, antes de todo.
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

  if (
    !isValidWebhookSignature({
      signatureHeader: request.headers.get("x-signature"),
      requestId: request.headers.get("x-request-id"),
      dataId,
      secret,
      now: new Date(),
    })
  ) {
    return respond(401);
  }

  // Probó ser Mercado Pago. Recién ahora se lee el cuerpo.
  let body: unknown;
  try {
    body = await request.json();
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
