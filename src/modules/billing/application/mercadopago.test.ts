import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreapproval, type PreapprovalDraft } from "./mercadopago";

/**
 * Tests del adaptador de Mercado Pago.
 *
 * Segundo llamado externo del proyecto y el primero que mueve plata. Lo que se
 * cuida acá no es el camino feliz: es que un monto mal armado NO salga hacia la
 * pasarela. Una cotización inventada la ataja `fx.ts`; acá lo que se ataja es
 * mandar el número correcto en la unidad equivocada, que cobra cien veces de
 * más y nadie lo ve hasta el resumen de la tarjeta.
 */

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ MERCADOPAGO_ACCESS_TOKEN: "TEST-token-de-prueba" }),
}));

/** USD 35 a 1300 pesos = 45.500 pesos = 4.550.000 centavos. */
const draft: PreapprovalDraft = {
  subscriptionId: "11111111-2222-3333-4444-555555555555",
  reason: "Turnos — plan Pro",
  payerEmail: "duenio@negocio.com",
  amountArsCents: 4_550_000,
  backUrl: "https://app.turnos.com/panel/suscripcion",
};

const okResponse = (body: unknown) =>
  ({ ok: true, status: 201, json: async () => body }) as unknown as Response;

/** Lo que devuelve MP al crear un preapproval en `pending`. */
const created = {
  id: "2c938084726fca480172750000000000",
  status: "pending",
  init_point: "https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=2c93",
  external_reference: draft.subscriptionId,
};

let fetchMock: ReturnType<typeof vi.fn>;

/** El cuerpo que se le mandó a MP, ya parseado. */
function sentBody(): Record<string, unknown> {
  const options = fetchMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(options.body));
}

function sentHeaders(): Record<string, string> {
  const options = fetchMock.mock.calls[0]![1] as RequestInit;
  return options.headers as Record<string, string>;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse(created));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // `unstubAllGlobals` NO deshace los `vi.spyOn`. Mismo motivo que en `fx.test.ts`.
  vi.restoreAllMocks();
});

describe("createPreapproval", () => {
  it("crea la suscripción contra el endpoint de preapproval", async () => {
    await createPreapproval(draft);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.mercadopago.com/preapproval",
    );
    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(options.method).toBe("POST");
  });

  /**
   * EL ERROR QUE COBRA CIEN VECES DE MÁS. Toda la plata de este proyecto viaja
   * en centavos, y `transaction_amount` de Mercado Pago va en PESOS. Mandar los
   * centavos tal cual cobraría 4.550.000 pesos en vez de 45.500. La conversión
   * vive acá, en el borde, y este test es lo único que la sostiene.
   */
  it("manda el monto en PESOS, no en centavos", async () => {
    await createPreapproval(draft);

    expect(sentBody().auto_recurring).toMatchObject({
      transaction_amount: 45_500,
      currency_id: "ARS",
    });
  });

  it("cobra una vez por mes", async () => {
    await createPreapproval(draft);

    expect(sentBody().auto_recurring).toMatchObject({
      frequency: 1,
      frequency_type: "months",
    });
  });

  /**
   * El `external_reference` es el id de NUESTRA suscripción, y es por donde el
   * webhook va a encontrar la fila cuando llegue un cobro. Sin esto el webhook
   * recibe un id de Mercado Pago que no sabe a qué negocio pertenece.
   */
  it("deja el id de la suscripción como referencia externa", async () => {
    await createPreapproval(draft);

    expect(sentBody().external_reference).toBe(draft.subscriptionId);
  });

  /**
   * `pending` y no `authorized`: nace sin medio de pago y el pagador lo elige
   * en el checkout de Mercado Pago. Mandar `authorized` exigiría un
   * `card_token_id`, o sea datos de tarjeta pasando por nuestro servidor.
   */
  it("nace pendiente, sin medio de pago", async () => {
    await createPreapproval(draft);

    expect(sentBody().status).toBe("pending");
    expect(sentBody()).not.toHaveProperty("card_token_id");
  });

  it("manda el mail del pagador, el motivo y la vuelta", async () => {
    await createPreapproval(draft);

    expect(sentBody()).toMatchObject({
      payer_email: draft.payerEmail,
      reason: draft.reason,
      back_url: draft.backUrl,
    });
  });

  it("autentica con el token del entorno", async () => {
    await createPreapproval(draft);

    expect(sentHeaders().Authorization).toBe("Bearer TEST-token-de-prueba");
    expect(sentHeaders()["Content-Type"]).toBe("application/json");
  });

  /**
   * Mismo motivo que en `fx.ts`: esto se llama desde el checkout y no puede
   * dejar a alguien mirando un spinner. Se prueba el VALOR del corte y que el
   * signal LLEGUE al fetch — un `AbortSignal` que nadie pasa no cancela nada.
   */
  it("corta a los 10 segundos, y el signal llega al fetch", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await createPreapproval(draft);

    expect(timeout).toHaveBeenCalledWith(10_000);
    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(options.signal).toBe(timeout.mock.results[0]!.value);
  });

  it("pide sin cache", async () => {
    await createPreapproval(draft);

    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(options.cache).toBe("no-store");
  });

  it("devuelve el id de la pasarela y el punto de checkout", async () => {
    const session = await createPreapproval(draft);

    expect(session.ok && session.value).toEqual({
      providerSubscriptionId: created.id,
      initPoint: created.init_point,
    });
  });

  /**
   * VALIDAR ANTES DE SALIR. Un monto que no es un múltiplo entero de cien
   * centavos no vino de `usdCentsToArsCents`, que redondea al peso entero: vino
   * de alguien que armó el número a mano. Frenarlo acá es frenarlo antes de que
   * exista una suscripción cobrando cualquier cosa, y sin gastar un llamado.
   */
  it.each([
    ["cero", 0],
    ["negativo", -4_550_000],
    ["con centavos de peso", 4_550_050],
    ["no finito", Number.NaN],
    ["infinito", Number.POSITIVE_INFINITY],
  ])("un monto %s no sale hacia la pasarela", async (_caso, amountArsCents) => {
    const session = await createPreapproval({ ...draft, amountArsCents });

    expect(!session.ok && session.error.code).toBe("mp_invalid_amount");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * LOS TRES FALLOS NO SON EL MISMO PROBLEMA.
   *
   * `mp_unreachable` es transitorio — no contestó, tardó, o se cayó del lado de
   * ellos. Reintentar sirve.
   *
   * `mp_rejected` es NUESTRA request mal armada: contestó 4xx. Reintentar la
   * misma request da lo mismo para siempre; hay que ir a mirarla.
   *
   * `mp_bad_response` es contrato roto: contestó 2xx con algo que no podemos
   * usar. Tampoco se arregla reintentando, pero el que lo arregla es otro.
   */
  it.each([
    ["la red se cayó", () => fetchMock.mockRejectedValue(new Error("down"))],
    [
      "cortó por tiempo",
      () =>
        fetchMock.mockRejectedValue(
          Object.assign(new Error("aborted"), { name: "TimeoutError" }),
        ),
    ],
    [
      "contestó 500",
      () =>
        fetchMock.mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({}),
        } as unknown as Response),
    ],
    [
      "contestó 503",
      () =>
        fetchMock.mockResolvedValue({
          ok: false,
          status: 503,
          json: async () => ({}),
        } as unknown as Response),
    ],
  ])("%s es un fallo TRANSITORIO", async (_caso, arrange) => {
    arrange();

    const session = await createPreapproval(draft);
    expect(!session.ok && session.error.code).toBe("mp_unreachable");
  });

  it.each([
    ["400", 400],
    ["401", 401],
    ["404", 404],
    ["422", 422],
  ])("un %s es una request RECHAZADA, no un problema de red", async (_caso, status) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status,
      json: async () => ({ message: "invalid payer_email" }),
    } as unknown as Response);

    const session = await createPreapproval(draft);
    expect(!session.ok && session.error.code).toBe("mp_rejected");
  });

  /**
   * FALLA CERRADO ante una respuesta incompleta. Sin `init_point` no hay a
   * dónde mandar al pagador, y sin `id` no hay con qué atar la suscripción
   * cuando llegue el webhook. Una sesión a medias es peor que ninguna: deja una
   * fila que dice que se está cobrando cuando no se está cobrando nada.
   */
  it.each([
    ["sin id", { ...created, id: undefined }],
    ["con id vacío", { ...created, id: "   " }],
    ["con id que no es texto", { ...created, id: 12345 }],
    ["sin init_point", { ...created, init_point: undefined }],
    ["con init_point vacío", { ...created, init_point: "" }],
    ["con un cuerpo que no es objeto", null],
  ])("una respuesta %s no da sesión de checkout", async (_caso, body) => {
    fetchMock.mockResolvedValue(okResponse(body));

    const session = await createPreapproval(draft);
    expect(!session.ok && session.error.code).toBe("mp_bad_response");
  });

  it("un cuerpo que no es JSON legible tampoco da sesión", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);

    const session = await createPreapproval(draft);
    expect(!session.ok && session.error.code).toBe("mp_bad_response");
  });

  /**
   * El token de acceso de Mercado Pago cobra plata. Los mensajes de error se
   * renderizan tal cual en la pantalla del dueño del negocio (ver
   * `booking-flow.tsx`), así que un mensaje que lo arrastre lo publica.
   */
  it("ningún mensaje de error arrastra el token", async () => {
    fetchMock.mockRejectedValue(new Error("connect ETIMEDOUT TEST-token-de-prueba"));

    const session = await createPreapproval(draft);
    expect(session.ok).toBe(false);
    expect(!session.ok && session.error.message).not.toContain("TEST-token");
  });
});
