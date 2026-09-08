import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok } from "@/core/result";

import { cancelSubscription } from "./cancel";

/**
 * Tests de la baja de suscripción.
 *
 * Lo que se cuida acá es EL ORDEN, que es todo el diseño de esta función. Los
 * dos desenlaces feos no son simétricos:
 *
 *   · Escribir primero y que Mercado Pago falle deja una fila que dice "dada
 *     de baja" mientras la tarjeta se sigue debitando. El dueño se entera
 *     treinta días después y no hay nada que lo corrija solo.
 *   · Cancelar primero y que falle nuestra escritura deja de cobrar y nuestra
 *     fila vieja — y el webhook `preapproval.cancelled` la corrige sin que
 *     nadie haga nada.
 *
 * Por eso Mercado Pago va primero. Los tests de abajo fallan si alguien
 * invierte los dos pasos "para escribir menos".
 */

const liveSubscription = {
  id: "sub-1",
  providerSubscriptionId: "2c93-preapproval",
};

let readResult: unknown = ok(liveSubscription);
let mpResult: unknown = ok(undefined);
let rpcResult: { data: unknown; error: unknown } = {
  data: "canceled",
  error: null,
};
/** Cuando está seteado, `createAdminClient` TIRA en vez de devolver cliente. */
let adminFailure: Error | null = null;

/** El orden real en que se llamó a cada colaborador. Es lo que se afirma. */
let calls: string[] = [];

const getLiveSubscriptionForCancel = vi.fn(async () => {
  calls.push("read");
  return readResult;
});
const cancelPreapproval = vi.fn(async () => {
  calls.push("mercadopago");
  return mpResult;
});
const rpc = vi.fn(async (...args: unknown[]) => {
  calls.push("write");
  void args;
  return rpcResult;
});

vi.mock("./queries", () => ({
  getLiveSubscriptionForCancel: (...args: unknown[]) =>
    getLiveSubscriptionForCancel(...(args as [])),
}));

vi.mock("./mercadopago", () => ({
  cancelPreapproval: (...args: unknown[]) =>
    cancelPreapproval(...(args as [])),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return { rpc };
  },
}));

beforeEach(() => {
  // `resetAllMocks` y no `clearAllMocks`: el segundo borra las llamadas pero
  // NO la implementación de un `mockResolvedValue`, así que un caso que pisa
  // la respuesta se la deja puesta al siguiente.
  vi.resetAllMocks();
  getLiveSubscriptionForCancel.mockImplementation(async () => {
    calls.push("read");
    return readResult;
  });
  cancelPreapproval.mockImplementation(async () => {
    calls.push("mercadopago");
    return mpResult;
  });
  rpc.mockImplementation(async () => {
    calls.push("write");
    return rpcResult;
  });
  calls = [];
  readResult = ok(liveSubscription);
  mpResult = ok(undefined);
  rpcResult = { data: "canceled", error: null };
  adminFailure = null;
});

describe("cancelSubscription", () => {
  it("da de baja y lo informa", async () => {
    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("canceled");
  });

  /**
   * EL TEST QUE DEFINE LA FUNCIÓN. Primero se corta el cobro, después se
   * escribe. Invertirlo es lo que deja a alguien pagando una suscripción que
   * nuestra pantalla ya da por terminada.
   */
  it("corta el cobro en Mercado Pago ANTES de escribir nuestra fila", async () => {
    await cancelSubscription("tenant-1");

    expect(calls).toEqual(["read", "mercadopago", "write"]);
  });

  it("le pide la baja del preapproval que corresponde", async () => {
    await cancelSubscription("tenant-1");

    expect(cancelPreapproval).toHaveBeenCalledWith("2c93-preapproval");
  });

  it("da de baja la suscripción del negocio que se pidió", async () => {
    await cancelSubscription("tenant-1");

    expect(rpc).toHaveBeenCalledWith("cancel_subscription", {
      p_tenant_id: "tenant-1",
    });
  });

  /**
   * Un negocio que está en la prueba y nunca pasó por el checkout no tiene
   * nada abierto en Mercado Pago. Pedirle que cancele un preapproval que no
   * existe da 404, que vuelve como `mp_rejected` y frenaría una baja
   * perfectamente legítima.
   */
  it("no llama a Mercado Pago si nunca hubo preapproval", async () => {
    readResult = ok({ id: "sub-1", providerSubscriptionId: null });

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(true);
    expect(cancelPreapproval).not.toHaveBeenCalled();
    expect(calls).toEqual(["read", "write"]);
  });

  it("si no se puede leer la suscripción, no toca nada", async () => {
    readResult = err(appError("subscription_query_failed", "no se pudo leer"));

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("subscription_query_failed");
    expect(cancelPreapproval).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * Y si Mercado Pago no cancela, NUESTRA FILA NO SE TOCA. Escribirla igual
   * sería exactamente la mentira que el orden existe para evitar: pantalla
   * dada de baja, tarjeta debitando.
   */
  it("si Mercado Pago falla, no escribe nuestra fila", async () => {
    mpResult = err(appError("mp_unreachable", "no contestó"));

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_unreachable");
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * El caso al revés sí es recuperable, y el mensaje tiene que decirlo: ya no
   * se le cobra más, y el webhook `preapproval.cancelled` corrige la fila
   * solo. Decirle "no se pudo dar de baja" a secas lo mandaría a reintentar
   * algo que ya está hecho, o a escribirnos asustado.
   */
  it("si Mercado Pago cortó pero no pudimos registrarlo, lo dice sin asustar", async () => {
    rpcResult = { data: null, error: { message: "se cayó" } };

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancel_not_recorded");
      expect(result.error.message).toContain("no se te va a cobrar");
    }
  });

  /**
   * `createAdminClient()` REVIENTA si falta la service-role key, no devuelve
   * un cliente vacío. Mirar sólo el `error` del rpc deja afuera justo ese
   * camino, y una excepción acá es un 500 opaco en la cara del dueño. Mismo
   * aprendizaje que ya está escrito en `checkout.ts` y en `webhook.ts`.
   */
  it("una excepción al crear el cliente admin se trata igual que un fallo de escritura", async () => {
    adminFailure = new Error("falta la service-role key");

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancel_not_recorded");
  });

  /**
   * Darse de baja dos veces es éxito, no error. Pasa de verdad: el botón se
   * aprieta dos veces, o el webhook se adelantó a nuestra escritura.
   */
  it("una segunda baja es éxito", async () => {
    rpcResult = { data: "already_canceled", error: null };

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("already_canceled");
  });

  /**
   * `no_subscription` no puede pasar después de que la lectura encontró una
   * viva — significa que algo la movió en el medio. No se lo trata como éxito:
   * lo único peor que un estado raro es esconderlo.
   */
  it("un no_subscription después de haber leído una viva es un error", async () => {
    rpcResult = { data: "no_subscription", error: null };

    const result = await cancelSubscription("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancel_not_recorded");
  });
});
