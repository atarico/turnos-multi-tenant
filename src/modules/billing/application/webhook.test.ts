import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyWebhookNotification } from "./webhook";

/**
 * Tests del webhook, del cuerpo de la notificación hasta la base.
 *
 * Lo que se cuida acá no es el camino feliz. Es que NADA active una suscripción
 * sin que Mercado Pago lo haya confirmado, y que un fallo a mitad de camino
 * diga "reintentá" en vez de tragarse un cobro en silencio.
 */

const rpc = vi.fn();
const fetchEvent = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc }),
}));

vi.mock("./mercadopago", () => ({
  fetchSubscriptionEvent: (...args: unknown[]) => fetchEvent(...args),
}));

/** Un cobro mensual que entró bien. */
const notification = {
  type: "subscription_authorized_payment",
  action: "created",
  data: { id: "9876543210" },
};

beforeEach(() => {
  rpc.mockReset();
  fetchEvent.mockReset();

  fetchEvent.mockResolvedValue({
    ok: true,
    value: {
      providerSubscriptionId: "MP-PREAPPROVAL-1",
      providerStatus: "processed",
    },
  });
  rpc.mockResolvedValue({ data: "applied", error: null });
});

describe("applyWebhookNotification", () => {
  it("aplica un cobro confirmado", async () => {
    const result = await applyWebhookNotification(notification);

    expect(result.ok && result.value).toBe("applied");
    expect(fetchEvent).toHaveBeenCalledWith("authorized_payment", "9876543210");
  });

  it("le manda a la base la clave de idempotencia con el estado adentro", async () => {
    await applyWebhookNotification(notification);

    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.p_provider).toBe("mercadopago");
    expect(args.p_provider_event_id).toBe(
      "authorized_payment:9876543210:processed",
    );
    expect(args.p_provider_subscription_id).toBe("MP-PREAPPROVAL-1");
    expect(args.p_status).toBe("active");
  });

  it("NO le cree al cuerpo de la notificación: le pregunta a Mercado Pago", async () => {
    // Es lo único que impide que quien adivine un id de recurso active una
    // suscripción diciendo que está paga. El estado sale SIEMPRE del llamado.
    fetchEvent.mockResolvedValue({
      ok: true,
      value: {
        providerSubscriptionId: "MP-PREAPPROVAL-1",
        providerStatus: "recycling",
      },
    });

    await applyWebhookNotification({
      ...notification,
      // Un atacante mandando el estado que le conviene dentro del cuerpo.
      status: "processed",
    });

    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.p_status).toBe("past_due");
  });

  it("ignora un tema que no es de suscripción sin tocar nada", async () => {
    const result = await applyWebhookNotification({
      type: "payment",
      data: { id: "1" },
    });

    expect(result.ok && result.value).toBe("ignored");
    expect(fetchEvent).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ignora un cuerpo roto sin tirar", async () => {
    for (const body of [null, "basura", {}, { type: "subscription_preapproval" }]) {
      const result = await applyWebhookNotification(body);
      expect(result.ok && result.value).toBe("ignored");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ignora un estado que todavía no mueve nada, sin escribir", async () => {
    // `pending` es la suscripción recién abierta por el checkout. Escribirlo
    // gastaría una fila de evento por algo que no cambia nada.
    fetchEvent.mockResolvedValue({
      ok: true,
      value: {
        providerSubscriptionId: "MP-PREAPPROVAL-1",
        providerStatus: "pending",
      },
    });

    const result = await applyWebhookNotification({
      type: "subscription_preapproval",
      data: { id: "MP-PREAPPROVAL-1" },
    });

    expect(result.ok && result.value).toBe("ignored");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propaga el fallo de Mercado Pago sin escribir en la base", async () => {
    fetchEvent.mockResolvedValue({
      ok: false,
      error: { code: "mp_unreachable", message: "no se pudo" },
    });

    const result = await applyWebhookNotification(notification);

    expect(!result.ok && result.error.code).toBe("mp_unreachable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("devuelve lo que dijo la base: un reintento es duplicado", async () => {
    rpc.mockResolvedValue({ data: "duplicate", error: null });

    const result = await applyWebhookNotification(notification);
    expect(result.ok && result.value).toBe("duplicate");
  });

  it("un preapproval que no conocemos NO es éxito", async () => {
    // Puede ser la carrera con el checkout: Mercado Pago avisó antes de que
    // estampáramos el id. Tiene que pedir reintento, no darse por aplicado.
    rpc.mockResolvedValue({ data: "unknown_subscription", error: null });

    const result = await applyWebhookNotification(notification);
    expect(!result.ok && result.error.code).toBe("webhook_unknown_subscription");
  });

  it("una suscripción ya cancelada se acepta y no se reintenta", async () => {
    rpc.mockResolvedValue({ data: "not_live", error: null });

    const result = await applyWebhookNotification(notification);
    expect(result.ok && result.value).toBe("not_live");
  });

  it("un error de PostgREST pide reintento", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await applyWebhookNotification(notification);
    expect(!result.ok && result.error.code).toBe("webhook_not_applied");
  });

  it("una base que TIRA también, no sólo la que devuelve error", async () => {
    // `createAdminClient()` revienta si falta la service-role key. Sin este
    // camino, esa falta se ve como un 500 opaco y Mercado Pago no reintenta.
    rpc.mockRejectedValue(new Error("sin service role"));

    const result = await applyWebhookNotification(notification);
    expect(!result.ok && result.error.code).toBe("webhook_not_applied");
  });

  it("una respuesta inesperada de la función no se toma por buena", async () => {
    rpc.mockResolvedValue({ data: "lo-que-sea", error: null });

    const result = await applyWebhookNotification(notification);
    expect(!result.ok && result.error.code).toBe("webhook_not_applied");
  });
});
