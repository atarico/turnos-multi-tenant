import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  eventKey,
  mapProviderStatus,
  parseWebhookNotification,
} from "../domain/webhook-event";
import { fetchSubscriptionEvent } from "./mercadopago";

/** Quién cobra. Hoy hay una sola. Ver `checkout.ts`. */
const PROVIDER = "mercadopago";

/**
 * Cómo terminó una notificación, cuando terminó bien.
 *
 * Los tres son ÉXITO y los tres significan cosas distintas, que es lo que hace
 * que valga la pena distinguirlos en el log:
 *
 *   · `applied` — se movió algo.
 *   · `duplicate` — Mercado Pago reintentó y la base lo frenó. Esperable, no
 *     es un problema.
 *   · `ignored` — no había nada que aplicar: otro tema, un cuerpo roto, o un
 *     estado que todavía no mueve nada.
 *   · `not_live` — la suscripción ya estaba cancelada.
 *
 * Todos responden 200. Un 4xx o un 5xx acá haría que Mercado Pago reintente
 * cada quince minutos para siempre algo que ya está resuelto.
 */
export type WebhookOutcome = "applied" | "duplicate" | "ignored" | "not_live";

/**
 * Los valores que devuelve `apply_subscription_payment`, y qué significan de
 * este lado.
 *
 * `unknown_subscription` NO está acá y no es un olvido: es el único que pide
 * reintento. Puede ser la carrera con el checkout —Mercado Pago avisando antes
 * de que `attach_subscription_checkout` alcance a estampar el id— y en ese
 * caso el reintento es justamente lo que la arregla. Darlo por bueno con un
 * 200 tiraría el cobro a la basura.
 *
 * `invalid_status` tampoco: significa que el mapeo produjo algo que la función
 * no acepta, o sea un bug nuestro. Un 200 lo escondería.
 */
const SUCCESS: Record<string, WebhookOutcome> = Object.assign(
  Object.create(null) as Record<string, WebhookOutcome>,
  {
    applied: "applied",
    duplicate: "duplicate",
    not_live: "not_live",
  },
);

const notApplied = () =>
  err(
    appError(
      "webhook_not_applied",
      "No pudimos aplicar la notificación de cobro.",
    ),
  );

const unknownSubscription = () =>
  err(
    appError(
      "webhook_unknown_subscription",
      "La notificación no corresponde a ninguna suscripción conocida.",
    ),
  );

/**
 * Aplica una notificación de Mercado Pago sobre la suscripción que le
 * corresponde.
 *
 * NO AUTENTICA NADA. Asume que quien la llama ya probó que la notificación es
 * de Mercado Pago; ese portón es `isValidWebhookSignature` y vive en el Route
 * Handler. Separarlos es lo que deja probar esta lógica sin armar firmas.
 *
 * EL ORDEN, otra vez, es la parte que importa:
 *
 *   1. Leer el cuerpo. Lo único que se le cree es QUÉ recurso cambió.
 *   2. Preguntarle a Mercado Pago el estado REAL de ese recurso. El cuerpo
 *      nunca dice si el cobro salió bien, y si lo dijera tampoco habría que
 *      creerle: la firma prueba que el aviso es de ellos, no que el JSON de
 *      adentro sea cierto.
 *   3. Traducir ese estado al nuestro.
 *   4. Recién ahí escribir, con una clave que hace la escritura idempotente.
 *
 * Si el paso 2 falla NO se escribe nada. Una notificación aplicada a partir de
 * un estado que no se pudo confirmar es peor que una no aplicada: la segunda
 * se arregla con el reintento de Mercado Pago, la primera activa a alguien que
 * no pagó.
 */
export async function applyWebhookNotification(
  body: unknown,
): Promise<Result<WebhookOutcome>> {
  const event = parseWebhookNotification(body);
  // No es un error: llegan temas que no nos interesan y cuerpos rotos, y a los
  // dos se les responde 200 para que no se reintenten para siempre.
  if (!event) return ok("ignored");

  const resource = await fetchSubscriptionEvent(event.kind, event.resourceId);
  if (!resource.ok) return resource;

  const status = mapProviderStatus(event.kind, resource.value.providerStatus);
  // `pending` y `scheduled` caen acá. Son legítimos y no mueven nada; escribir
  // una fila de evento por ellos sólo gastaría espacio.
  if (!status) return ok("ignored");

  let applied: { data: unknown; error: unknown };
  try {
    const admin = createAdminClient();
    applied = await admin.rpc("apply_subscription_payment", {
      p_provider: PROVIDER,
      // La clave lleva el estado adentro. Ver la nota larga en `eventKey`: sin
      // eso, el aviso de reintento de tarjeta reclamaría el evento y el cobro
      // exitoso que llega después se descartaría como duplicado.
      p_provider_event_id: eventKey(
        event.kind,
        event.resourceId,
        resource.value.providerStatus,
      ),
      p_provider_subscription_id: resource.value.providerSubscriptionId,
      p_event_type: `${event.kind}.${resource.value.providerStatus}`,
      p_status: status,
    });
  } catch {
    // TODO EL BLOQUE dentro del `try`, incluida la creación del cliente:
    // `createAdminClient()` revienta si falta la service-role key. Mirar sólo
    // `applied.error` deja afuera el fallo que TIRA, y una excepción acá es un
    // 500 opaco sin el código que le dice a quien llama que hay que
    // reintentar. Mismo aprendizaje que en `checkout.ts`.
    return notApplied();
  }

  if (applied.error) return notApplied();

  if (applied.data === "unknown_subscription") return unknownSubscription();

  const outcome = typeof applied.data === "string" ? SUCCESS[applied.data] : undefined;
  // Cualquier otra cosa —`invalid_status`, un valor nuevo, `null`— se trata
  // como no aplicada. Darla por buena escondería un mapeo roto detrás de un
  // 200 y el negocio pagaría sin activarse.
  if (!outcome) return notApplied();

  return ok(outcome);
}
