import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok } from "@/core/result";

import { startCheckout } from "./checkout";

/**
 * Tests del checkout: lo único que ata el precio, la cotización del día y la
 * pasarela en una sola operación.
 *
 * Lo que se cuida es el ORDEN y qué pasa cuando un paso falla. Cada paso que se
 * saltea o se hace fuera de tiempo deja un estado que después hay que arreglar
 * a mano sobre plata de alguien: una suscripción abierta en Mercado Pago que
 * nuestra base no conoce, o una fila que dice que se cobra cuando no se cobra.
 */

const rpc = vi.fn();

/**
 * Lo que devuelve `redeem_coupon`. `null` es el cupón que no sirve, y cubre los
 * cuatro motivos —no existe, apagado, vencido, agotado— porque la función de la
 * base los colapsa a propósito.
 */
let couponDiscount: number | null = null;

vi.mock("./queries", () => ({
  getLiveSubscriptionIdForCharge: vi.fn(),
}));
vi.mock("./fx", () => ({ quoteUsdToArs: vi.fn() }));
vi.mock("./mercadopago", () => ({ createPreapproval: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc }),
}));

const { getLiveSubscriptionIdForCharge } = await import("./queries");
const { quoteUsdToArs } = await import("./fx");
const { createPreapproval } = await import("./mercadopago");

const SUBSCRIPTION_ID = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-08-17T20:58:00.000Z");

const quote = {
  rate: 1300,
  source: "dolarapi:bolsa",
  quotedAt: new Date("2026-08-17T18:58:00.000Z"),
};

const session = {
  providerSubscriptionId: "2c938084726fca48",
  initPoint: "https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=2c93",
};

const params = {
  tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  plan: "pro" as const,
  payerEmail: "duenio@negocio.com",
  backUrl: "https://app.turnos.com/panel/suscripcion",
  now: NOW,
};

beforeEach(() => {
  // Sin esto los contadores de llamadas se acumulan entre tests, y los
  // `not.toHaveBeenCalled()` de más abajo —que son los que prueban que un paso
  // NO se ejecutó— pasarían a fallar por lo que hizo el test anterior.
  vi.clearAllMocks();

  vi.mocked(getLiveSubscriptionIdForCharge).mockResolvedValue(ok(SUBSCRIPTION_ID));
  vi.mocked(quoteUsdToArs).mockResolvedValue(ok(quote));
  vi.mocked(createPreapproval).mockResolvedValue(ok(session));
  couponDiscount = null;
  // El mismo `rpc` atiende dos funciones distintas, así que despacha por
  // nombre. Devolver `true` para todo haría que un canje inválido pareciera un
  // descuento de `true` y el test no probaría nada del camino del cupón.
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "redeem_coupon"
        ? { data: couponDiscount, error: null }
        : { data: true, error: null },
    ),
  );
});

describe("startCheckout", () => {
  it("devuelve a dónde mandar al pagador", async () => {
    const result = await startCheckout(params);

    expect(result.ok && result.value.initPoint).toBe(session.initPoint);
  });

  /**
   * USD 35 (Pro) a 1300 = 45.500 pesos = 4.550.000 centavos. El monto que sale
   * hacia la pasarela tiene que ser el que produce la cotización de ESTE
   * momento, no un precio de lista ni uno guardado antes.
   */
  it("cobra el precio del plan convertido a la cotización del día", async () => {
    await startCheckout(params);

    expect(vi.mocked(createPreapproval).mock.calls[0]![0]).toMatchObject({
      amountArsCents: 4_550_000,
      subscriptionId: SUBSCRIPTION_ID,
      payerEmail: params.payerEmail,
      backUrl: params.backUrl,
    });
  });

  /**
   * El `reason` es lo que el dueño va a leer en el resumen de la tarjeta meses
   * después. Que nombre el plan es lo que evita un desconocimiento de cargo.
   */
  it("el motivo del cobro nombra el plan", async () => {
    await startCheckout(params);

    expect(vi.mocked(createPreapproval).mock.calls[0]![0]!.reason).toContain("Pro");
  });

  /**
   * La cotización se pide con el `now` que entra, no con uno propio. Sin esto
   * el chequeo de frescura de `fx.ts` se evalúa contra otro reloj que el del
   * resto de la operación.
   */
  it("cotiza con el reloj que le pasan", async () => {
    await startCheckout(params);

    expect(vi.mocked(quoteUsdToArs)).toHaveBeenCalledWith(NOW);
  });

  /**
   * LA COTIZACIÓN SE GUARDA JUNTO AL MONTO, siempre las tres cosas. La base lo
   * exige (`subscriptions_fx_complete`) pero el motivo no es la base: sin tasa,
   * fuente y fecha no hay forma de explicar después por qué se cobró eso.
   */
  it("estampa precio, monto y la cotización entera en la suscripción", async () => {
    await startCheckout(params);

    expect(rpc).toHaveBeenCalledWith("attach_subscription_checkout", {
      p_tenant_id: params.tenantId,
      p_subscription_id: SUBSCRIPTION_ID,
      p_plan: "pro",
      p_price_usd_cents: 3500,
      p_charged_amount_cents: 4_550_000,
      p_fx_rate: quote.rate,
      p_fx_source: quote.source,
      p_fx_quoted_at: quote.quotedAt.toISOString(),
      p_provider: "mercadopago",
      p_provider_subscription_id: session.providerSubscriptionId,
      // Sin cupón viajan explícitos en null, no ausentes: el CHECK de
      // `subscription_provider_refs` exige los dos o ninguno.
      p_coupon_code: null,
      p_discount_bps: null,
    });
  });

  /**
   * EL ORDEN NO ES ARBITRARIO. Estampar antes de que la pasarela conteste
   * dejaría una fila diciendo que se cobra por un id que puede no existir
   * nunca. Primero se abre del lado de ellos, después se guarda.
   */
  it("no estampa nada antes de que la pasarela conteste", async () => {
    const order: string[] = [];
    vi.mocked(createPreapproval).mockImplementation(async () => {
      order.push("mercadopago");
      return ok(session);
    });
    rpc.mockImplementation(async () => {
      order.push("estampa");
      return { data: true, error: null };
    });

    await startCheckout(params);

    expect(order).toEqual(["mercadopago", "estampa"]);
  });

  /**
   * Sin suscripción viva no hay a qué atar el cobro, y el fallo tiene que
   * distinguirse de "la base no contestó" — por eso la lectura devuelve
   * `Result` y no `null`. Se corta antes de tocar la pasarela.
   */
  it.each([
    ["no hay suscripción", appError("subscription_not_found", "…")],
    ["la base no contestó", appError("subscription_query_failed", "…")],
  ])("si %s no se abre nada en la pasarela", async (_caso, error) => {
    vi.mocked(getLiveSubscriptionIdForCharge).mockResolvedValue(err(error));

    const result = await startCheckout(params);

    expect(!result.ok && result.error.code).toBe(error.code);
    expect(vi.mocked(createPreapproval)).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * Sin cotización NO se cobra. Es la regla de `fx.ts` sostenida un nivel más
   * arriba: no hay último valor conocido ni precio de lista de respaldo, porque
   * cobrar un número inventado es peor que no cobrar. Y el código del fallo se
   * propaga tal cual para que quien lo lea sepa si reintentar sirve.
   */
  it.each([
    ["fx_unreachable", "fx_unreachable"],
    ["fx_bad_response", "fx_bad_response"],
  ])("sin cotización (%s) no se abre nada en la pasarela", async (_caso, code) => {
    vi.mocked(quoteUsdToArs).mockResolvedValue(err(appError(code, "…")));

    const result = await startCheckout(params);

    expect(!result.ok && result.error.code).toBe(code);
    expect(vi.mocked(createPreapproval)).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * Los códigos de la pasarela viajan enteros hasta arriba. Colapsarlos en uno
   * solo perdería lo que distinguen: `mp_unreachable` se reintenta,
   * `mp_rejected` no se arregla reintentando.
   */
  it.each([["mp_unreachable"], ["mp_rejected"], ["mp_bad_response"]])(
    "%s se propaga y no se estampa nada",
    async (code) => {
      vi.mocked(createPreapproval).mockResolvedValue(err(appError(code, "…")));

      const result = await startCheckout(params);

      expect(!result.ok && result.error.code).toBe(code);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  /**
   * EL BORDE ENTRE EL CÓDIGO Y LA COLUMNA. `charged_amount_cents` es `int`, que
   * corta en 2.147.483.647, y la banda de plausibilidad de `fx.ts` acepta hasta
   * 10.000.000 pesos por dólar. Premium a una tasa así da 70.000.000.000
   * centavos: el `UPDATE` explota por desborde numérico.
   *
   * Y explota TARDE — después de que la pasarela ya abrió la suscripción —, o
   * sea que produce exactamente el huérfano que todo este orden trata de
   * evitar. Por eso se chequea ANTES de tocar la pasarela y no se confía en que
   * la base lo ataje.
   */
  it("un monto que no entra en la columna se frena antes de la pasarela", async () => {
    vi.mocked(quoteUsdToArs).mockResolvedValue(
      ok({ ...quote, rate: 9_000_000 }),
    );

    const result = await startCheckout({ ...params, plan: "premium" });

    expect(!result.ok && result.error.code).toBe("price_out_of_range");
    expect(vi.mocked(createPreapproval)).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * LOS DOS MONTOS ADYACENTES QUE SÍ EXISTEN, y no el límite en sí.
   *
   * `usdCentsToArsCents` redondea al peso entero, así que todo monto es un
   * múltiplo de cien: el techo del `int` (2.147.483.647) NO es alcanzable, y
   * por eso acá un `>` y un `>=` son indistinguibles — a diferencia de las
   * bandas de `fx.ts`, donde el borde sí se puede producir y cambiar el
   * operador corre el rango de verdad.
   *
   * Lo que estos dos tests anclan es la ventana de cien centavos donde cae el
   * límite: 2.147.483.600 entra y 2.147.483.700 no. Mover la constante a otro
   * múltiplo de cien rompe uno de los dos.
   */
  it("el monto más alto que entra en la columna pasa", async () => {
    // USD 35 a 613.566,72 → 21.474.836 pesos → 2.147.483.600 centavos.
    vi.mocked(quoteUsdToArs).mockResolvedValue(ok({ ...quote, rate: 613_566.72 }));

    const result = await startCheckout({ ...params, plan: "pro" });

    expect(result.ok).toBe(true);
    expect(vi.mocked(createPreapproval).mock.calls[0]![0]!.amountArsCents).toBe(
      2_147_483_600,
    );
  });

  it("el múltiplo de cien siguiente ya no entra", async () => {
    // USD 35 a 613.566,76 → 21.474.837 pesos → 2.147.483.700 centavos.
    vi.mocked(quoteUsdToArs).mockResolvedValue(ok({ ...quote, rate: 613_566.76 }));

    const result = await startCheckout({ ...params, plan: "pro" });

    expect(!result.ok && result.error.code).toBe("price_out_of_range");
    expect(vi.mocked(createPreapproval)).not.toHaveBeenCalled();
  });

  /**
   * LA VENTANA FEA, y por eso tiene código propio. Acá la suscripción YA existe
   * en Mercado Pago y nuestra fila no la conoce: no alcanza con decir "error",
   * porque quien atienda esto tiene que saber que hay algo abierto del otro
   * lado esperando ser reconciliado por `external_reference`.
   */
  it("si la pasarela abrió pero la base no guardó, el error lo dice", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await startCheckout(params);

    expect(!result.ok && result.error.code).toBe("checkout_not_stamped");
  });

  /**
   * La función de base devuelve `false` cuando no tocó ninguna fila: la
   * suscripción no es de este negocio, o ya está cancelada. `error: null` con
   * `data: false` es un NO, y tratarlo como éxito dejaría al dueño creyendo que
   * contrató algo.
   */
  it("un false de la base es un fallo, no un éxito silencioso", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    const result = await startCheckout(params);

    expect(!result.ok && result.error.code).toBe("checkout_not_stamped");
  });

  /**
   * LA BASE TAMBIÉN TIRA, no sólo devuelve `error`. Falta de configuración o
   * red caída hacen que `createAdminClient()` o el `rpc` revienten, y una
   * excepción acá se escapa de la función: el dueño ve un crash genérico justo
   * en el único momento en que hay algo abierto a su nombre en Mercado Pago.
   *
   * O sea que el modo de fallar más feo era el único sin probar. Los dos
   * caminos tienen que terminar en el mismo aviso, porque dejan al dueño en la
   * misma situación.
   */
  it("si la base TIRA en vez de devolver error, igual avisa lo mismo", async () => {
    rpc.mockRejectedValue(new Error("fetch failed"));

    const result = await startCheckout(params);

    expect(!result.ok && result.error.code).toBe("checkout_not_stamped");
  });

  /**
   * `usdCentsToArsCents` rompe ante una entrada imposible, y con las entradas
   * ya validadas río arriba ese camino no debería ocurrir nunca. "No debería
   * ocurrir" sobre plata no es una garantía: si ocurre tiene que salir como
   * error y no como excepción, y sin este test esa rama no se ejecuta jamás.
   */
  it("si la conversión de precio tira, sale como error y no como excepción", async () => {
    // Una tasa que pasa la banda de `fx.ts` pero rompe la conversión no existe,
    // así que se fuerza desde el único lugar que puede: una cotización cuyo
    // `rate` no es un número utilizable.
    vi.mocked(quoteUsdToArs).mockResolvedValue(
      ok({ ...quote, rate: Number.NaN }),
    );

    const result = await startCheckout(params);

    expect(!result.ok && result.error.code).toBe("price_conversion_failed");
    expect(vi.mocked(createPreapproval)).not.toHaveBeenCalled();
  });

  /**
   * El cupón, que es lo único que puede cambiar el monto DESPUÉS de cotizar.
   *
   * Lo que se cuida acá es el orden y el corte: el canje ocurre antes de abrir
   * el preapproval —no hay forma de descontar después— y un código que no sirve
   * frena todo en vez de seguir al precio de lista.
   */
  describe("con cupón", () => {
    it("manda a la pasarela el monto YA rebajado", async () => {
      couponDiscount = 9900;

      await startCheckout({ ...params, couponCode: "BETA99" });

      // 4.550.000 centavos - 99% = 45.500 centavos.
      expect(createPreapproval).toHaveBeenCalledWith(
        expect.objectContaining({ amountArsCents: 45_500 }),
      );
    });

    it("congela el cupón y su descuento en la fila de identidad", async () => {
      couponDiscount = 9900;

      await startCheckout({ ...params, couponCode: "BETA99" });

      expect(rpc).toHaveBeenCalledWith(
        "attach_subscription_checkout",
        expect.objectContaining({
          p_coupon_code: "BETA99",
          p_discount_bps: 9900,
          p_charged_amount_cents: 45_500,
        }),
      );
    });

    it("normaliza el código antes de canjearlo", async () => {
      couponDiscount = 5000;

      await startCheckout({ ...params, couponCode: "  beta99  " });

      expect(rpc).toHaveBeenCalledWith(
        "redeem_coupon",
        expect.objectContaining({ p_code: "BETA99" }),
      );
    });

    /**
     * Un código que no sirve CORTA. Seguir al precio de lista le cobraría el
     * total a alguien que escribió un cupón esperando pagar menos, y una
     * sorpresa sobre plata es un reclamo al banco.
     *
     * Y corta ANTES de la pasarela: si abriera el preapproval y después
     * fallara, quedaría una suscripción cobrando el precio entero que el dueño
     * nunca aceptó.
     */
    it("corta sin abrir nada cuando el cupón no sirve", async () => {
      couponDiscount = null;

      const result = await startCheckout({ ...params, couponCode: "TRUCHO" });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("coupon_invalid");
      expect(createPreapproval).not.toHaveBeenCalled();
    });

    it("no canjea nada cuando no se escribió ningún cupón", async () => {
      await startCheckout({ ...params, couponCode: "   " });

      expect(rpc).not.toHaveBeenCalledWith(
        "redeem_coupon",
        expect.anything(),
      );
    });

    /**
     * Si la base no contesta, NO se sigue al precio de lista por las mismas
     * razones que un cupón inválido, y se dice que fue un problema nuestro y no
     * del código que escribió.
     */
    it("corta cuando no se pudo validar el cupón", async () => {
      rpc.mockImplementation((fn: string) =>
        fn === "redeem_coupon"
          ? Promise.reject(new Error("sin red"))
          : Promise.resolve({ data: true, error: null }),
      );

      const result = await startCheckout({ ...params, couponCode: "BETA99" });

      expect(!result.ok && result.error.code).toBe("coupon_check_failed");
      expect(createPreapproval).not.toHaveBeenCalled();
    });
  });
});
