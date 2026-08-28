/**
 * Lectura de una notificación de Mercado Pago.
 *
 * Todo acá es PURO: no toca red, no lee el entorno, no tira. El cuerpo lo
 * escribe alguien de afuera —cualquiera puede pegarle al endpoint— así que
 * cada función devuelve `null` ante lo que no entiende en vez de romper. Una
 * excepción en este módulo es un 500 en el único portón del proyecto abierto a
 * internet, y un 500 que se provoca a voluntad es una forma barata de tirar
 * abajo el webhook que confirma los cobros.
 *
 * Lo que NO está acá, a propósito: el estado real del recurso. La notificación
 * trae un id y nada más — nunca dice si el cobro salió bien. Eso se le
 * pregunta a Mercado Pago. Ver `mercadopago.ts`.
 */

/**
 * Los dos tipos de aviso que importan para una suscripción.
 *
 * `preapproval` es la suscripción cambiando de estado (se autorizó, se pausó,
 * se dio de baja). `authorized_payment` es UN cobro mensual concreto. Son
 * cosas distintas y llegan por separado: la suscripción puede seguir
 * autorizada mientras un cobro puntual falla.
 */
export type WebhookEventKind = "preapproval" | "authorized_payment";

/** Lo único que una notificación dice de verdad: qué cambió y cuál. */
export interface WebhookEvent {
  kind: WebhookEventKind;
  /** El id del recurso del lado de Mercado Pago. */
  resourceId: string;
}

/** Lo que este proyecto puede aplicar sobre una suscripción desde un webhook. */
export type BillingStatus = "active" | "past_due" | "canceled";

/**
 * Los temas de la notificación, y a qué tipo de recurso corresponden.
 *
 * Objeto sin prototipo. Con un objeto literal común, `TOPICS["constructor"]`
 * devuelve una función heredada de `Object.prototype` en vez de `undefined`, y
 * el guard deja pasar un tema inventado. Es el mismo cuidado que ya está
 * escrito en `price.ts`.
 */
const TOPICS: Record<string, WebhookEventKind> = Object.assign(
  Object.create(null) as Record<string, WebhookEventKind>,
  {
    subscription_preapproval: "preapproval",
    subscription_authorized_payment: "authorized_payment",
  },
);

/**
 * Estados de Mercado Pago traducidos a los nuestros, por tipo de recurso.
 *
 * Las dos tablas están separadas y NO se cruzan: `processed` es un estado de
 * cobro y `authorized` uno de suscripción. Mezclarlas dejaría que un valor
 * llegado en el recurso equivocado active a alguien.
 *
 * Lo que no está en la tabla devuelve `null`, que significa "no hay nada que
 * aplicar" y no "error". `pending` y `scheduled` son estados legítimos que
 * simplemente no mueven nada todavía, y tratarlos como fallo llenaría el log
 * de ruido en el camino más común.
 *
 * OJO con `cancelled`: Mercado Pago lo escribe con dos eles y nuestro enum
 * `subscription_status` usa `canceled`. La tabla ES el lugar donde esa
 * diferencia se resuelve; escrita de memoria en otro lado, no se aplica la
 * baja y el negocio sigue pagando.
 */
const STATUSES: Record<
  WebhookEventKind,
  Record<string, BillingStatus>
> = {
  preapproval: Object.assign(
    Object.create(null) as Record<string, BillingStatus>,
    {
      authorized: "active",
      paused: "past_due",
      cancelled: "canceled",
    },
  ),
  authorized_payment: Object.assign(
    Object.create(null) as Record<string, BillingStatus>,
    {
      processed: "active",
      recycling: "past_due",
    },
  ),
};

/**
 * El id de un recurso, venga como texto o como número.
 *
 * Mercado Pago manda `data.id` a veces entrecomillado y a veces no, según el
 * tema. Aceptar los dos acá es lo que evita descartar la mitad de las
 * notificaciones por un tipo.
 *
 * Se rechaza explícitamente el booleano: `String(true)` da `"true"`, que es
 * texto no vacío y pasaría como id.
 */
function readId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

/**
 * El formato viejo manda `resource`, que puede ser el id pelado o la URL
 * entera del recurso. El id es el último tramo en los dos casos.
 */
function readResource(value: unknown): string | null {
  const raw = readId(value);
  if (!raw) return null;

  const last = raw.split("/").filter(Boolean).pop();
  return last ? last : null;
}

/**
 * ¿Qué dice esta notificación, si es que dice algo que nos sirva?
 *
 * Devuelve `null` para todo lo demás —tema desconocido, cuerpo roto, id
 * ausente— y quien llama responde 200 igual. Un 4xx ante un tema que no nos
 * interesa haría que Mercado Pago lo reintente para siempre.
 */
export function parseWebhookNotification(body: unknown): WebhookEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const { type, topic, data, resource } = body as {
    type?: unknown;
    topic?: unknown;
    data?: unknown;
    resource?: unknown;
  };

  const rawTopic = typeof type === "string" ? type : topic;
  if (typeof rawTopic !== "string") return null;

  const kind = TOPICS[rawTopic];
  if (!kind) return null;

  // `data.id` primero, que es el formato actual. `resource` es el de atrás.
  const fromData =
    typeof data === "object" && data !== null
      ? readId((data as { id?: unknown }).id)
      : null;

  const resourceId = fromData ?? readResource(resource);
  if (!resourceId) return null;

  return { kind, resourceId };
}

/**
 * El estado que dice Mercado Pago, traducido al nuestro.
 *
 * `null` significa "no hay nada que aplicar", no "falló": ver la nota sobre
 * `pending` y `scheduled` arriba de `STATUSES`.
 */
export function mapProviderStatus(
  kind: WebhookEventKind,
  providerStatus: string,
): BillingStatus | null {
  return STATUSES[kind][providerStatus] ?? null;
}

/**
 * La clave con la que la base reconoce que este efecto ya se aplicó.
 *
 * LLEVA EL ESTADO DEL PROVEEDOR, y esa es la parte que no es obvia. Un mismo
 * cobro mensual pasa por `recycling` —Mercado Pago reintentando la tarjeta— y
 * después por `processed` cuando entra. Los dos avisos traen EL MISMO id de
 * recurso. Con la clave armada sólo con el id, el primero reclamaría el evento
 * y el cobro exitoso se descartaría como duplicado: el negocio paga y se queda
 * en `past_due` para siempre.
 *
 * No se usa el id de la notificación —el `id` de arriba del cuerpo— porque
 * identifica al AVISO y no al efecto: dos avisos distintos del mismo cambio
 * pasarían los dos.
 */
export function eventKey(
  kind: WebhookEventKind,
  resourceId: string,
  providerStatus: string,
): string {
  return `${kind}:${resourceId}:${providerStatus}`;
}
