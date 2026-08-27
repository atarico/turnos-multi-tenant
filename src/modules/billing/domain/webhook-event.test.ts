import { describe, expect, it } from "vitest";

import {
  eventKey,
  mapProviderStatus,
  parseWebhookNotification,
} from "./webhook-event";

/**
 * Tests del portón de lectura del webhook.
 *
 * Todo lo de acá es puro y no toca red, y ese es justamente el punto: el
 * cuerpo de la notificación lo escribe alguien de afuera, así que cada
 * función tiene que sobrevivir a que le manden cualquier cosa sin tirar. Un
 * throw en este módulo es un 500 en el endpoint que confirma los cobros.
 */

describe("parseWebhookNotification", () => {
  it("lee una notificación de cobro autorizado", () => {
    expect(
      parseWebhookNotification({
        type: "subscription_authorized_payment",
        action: "created",
        data: { id: "9876543210" },
      }),
    ).toEqual({ kind: "authorized_payment", resourceId: "9876543210" });
  });

  it("lee una notificación de cambio de estado de la suscripción", () => {
    expect(
      parseWebhookNotification({
        type: "subscription_preapproval",
        data: { id: "2c938084726fca48" },
      }),
    ).toEqual({ kind: "preapproval", resourceId: "2c938084726fca48" });
  });

  it("acepta `topic` además de `type`, que es el formato viejo", () => {
    expect(
      parseWebhookNotification({
        topic: "subscription_preapproval",
        resource: "2c938084726fca48",
      }),
    ).toEqual({ kind: "preapproval", resourceId: "2c938084726fca48" });
  });

  it("saca el id de una `resource` que viene como URL", () => {
    expect(
      parseWebhookNotification({
        topic: "subscription_preapproval",
        resource: "https://api.mercadopago.com/preapproval/2c938084726fca48",
      }),
    ).toEqual({ kind: "preapproval", resourceId: "2c938084726fca48" });
  });

  it("acepta un id numérico, que es como lo manda Mercado Pago a veces", () => {
    expect(
      parseWebhookNotification({
        type: "subscription_authorized_payment",
        data: { id: 9876543210 },
      }),
    ).toEqual({ kind: "authorized_payment", resourceId: "9876543210" });
  });

  it("ignora los temas que no son de suscripción", () => {
    expect(
      parseWebhookNotification({ type: "payment", data: { id: "1" } }),
    ).toBeNull();
    expect(
      parseWebhookNotification({ type: "merchant_order", data: { id: "1" } }),
    ).toBeNull();
  });

  it("devuelve null ante un cuerpo inservible en vez de tirar", () => {
    for (const body of [
      null,
      undefined,
      "no soy json",
      42,
      [],
      {},
      { type: "subscription_preapproval" },
      { type: "subscription_preapproval", data: {} },
      { type: "subscription_preapproval", data: { id: "" } },
      { type: "subscription_preapproval", data: { id: "   " } },
      { type: "subscription_preapproval", data: null },
      { type: "subscription_preapproval", resource: "" },
      { type: "subscription_preapproval", data: { id: true } },
    ]) {
      expect(parseWebhookNotification(body)).toBeNull();
    }
  });

  it("no se deja engañar por una clave heredada de Object.prototype", () => {
    // `{}.constructor` existe y no es undefined. Si el guard preguntara por
    // "existe la clave" en vez de por el valor propio, esto pasaría.
    expect(
      parseWebhookNotification({ type: "constructor", data: { id: "1" } }),
    ).toBeNull();
  });
});

describe("mapProviderStatus", () => {
  it("un cobro procesado activa", () => {
    expect(mapProviderStatus("authorized_payment", "processed")).toBe("active");
  });

  it("un cobro en reintento deja en gracia, no da de baja", () => {
    // `recycling` es Mercado Pago reintentando la tarjeta. Bajarle el plan acá
    // convertiría una tarjeta vencida en una caída de servicio el mismo día.
    expect(mapProviderStatus("authorized_payment", "recycling")).toBe(
      "past_due",
    );
  });

  it("un cobro agendado todavía no es nada", () => {
    expect(mapProviderStatus("authorized_payment", "scheduled")).toBeNull();
  });

  it("una suscripción autorizada activa", () => {
    expect(mapProviderStatus("preapproval", "authorized")).toBe("active");
  });

  it("una suscripción pausada queda en gracia", () => {
    expect(mapProviderStatus("preapproval", "paused")).toBe("past_due");
  });

  it("una suscripción cancelada da de baja, con la ortografía de ellos", () => {
    // Ellos escriben `cancelled` con dos eles; nuestro enum usa `canceled`.
    expect(mapProviderStatus("preapproval", "cancelled")).toBe("canceled");
  });

  it("una suscripción pendiente no mueve nada", () => {
    // Nace en `pending`: el checkout ya la dejó ahí. No hay nada que aplicar.
    expect(mapProviderStatus("preapproval", "pending")).toBeNull();
  });

  it("devuelve null ante un estado que no conoce, sin inventar", () => {
    expect(mapProviderStatus("preapproval", "lo-que-sea")).toBeNull();
    expect(mapProviderStatus("authorized_payment", "")).toBeNull();
    // Un estado válido PERO del otro tipo de recurso no se cruza.
    expect(mapProviderStatus("preapproval", "processed")).toBeNull();
    expect(mapProviderStatus("authorized_payment", "authorized")).toBeNull();
  });
});

describe("eventKey", () => {
  it("incluye el estado del proveedor, no sólo el id del recurso", () => {
    // ES EL PUNTO DE TODO ESTO. Un mismo cobro pasa por `recycling` y después
    // por `processed`. Con la clave sin el estado, el primero reclamaría el
    // evento y el cobro exitoso se descartaría como duplicado: el negocio paga
    // y se queda en `past_due` para siempre.
    expect(eventKey("authorized_payment", "999", "recycling")).not.toBe(
      eventKey("authorized_payment", "999", "processed"),
    );
  });

  it("es estable: el mismo evento da la misma clave", () => {
    expect(eventKey("preapproval", "abc", "authorized")).toBe(
      eventKey("preapproval", "abc", "authorized"),
    );
  });

  it("separa los dos tipos de recurso aunque compartan id", () => {
    expect(eventKey("preapproval", "999", "authorized")).not.toBe(
      eventKey("authorized_payment", "999", "authorized"),
    );
  });
});
