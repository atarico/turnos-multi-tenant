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
 *
 * `mp_rejected` NO ESTÁ ACÁ, y no es un olvido. `mercadopago.ts` dice —con
 * razón— que reintentar esa request devuelve lo mismo para siempre, y eso
 * podría leerse como que acá corresponde un 200. No corresponde: los dos lados
 * de esta decisión no cuestan lo mismo.
 *
 * El caso concreto es el token vencido. El webhook empieza a contestar 4xx.
 * Con 5xx, Mercado Pago sigue reintentando y el día que alguien renueva el
 * token los cobros entran solos, sin perder ninguno. Con 200, cada cobro que
 * llegó mientras estaba roto se tira a la basura en silencio.
 *
 * O sea: reintentar de más cuesta invocaciones; reintentar de menos cuesta
 * plata de un cliente que pagó. Por eso el default es reintentar.
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

    const retryable = !NOT_RETRYABLE.has(applied.error.code);

    // La única señal de que algo se rompió. Sin esto, un webhook que falla
    // reintenta cada quince minutos y NO QUEDA REGISTRO DE NADA: el 5xx protege
    // el cobro pero no le avisa a nadie, así que la falla es "ruidosa" sólo del
    // lado de Mercado Pago y silenciosa del nuestro. Un token vencido puede
    // estar tirando cobros al aire durante días sin que nada lo diga.
    //
    // Sale el CÓDIGO, no el mensaje ni el error atrapado: los códigos son una
    // lista cerrada que escribimos nosotros, así que no pueden arrastrar el
    // secreto ni la URL de la base hacia el log.
    console.error(
      `[mp-webhook] no aplicada: ${applied.error.code}` +
        (retryable ? " — se pide reintento" : " — no se reintenta"),
    );

    return respond(retryable ? 500 : 200);
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
