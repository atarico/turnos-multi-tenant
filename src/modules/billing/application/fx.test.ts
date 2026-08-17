import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quoteUsdToArs } from "./fx";

/**
 * Tests del único llamado a un servicio externo de todo el proyecto.
 *
 * Lo que se cuida acá no es el camino feliz sino los torcidos: esta cotización
 * termina siendo el número por el que se le cobra a alguien. Una respuesta rara
 * que se cuele produce un precio inventado, y eso es peor que no poder cobrar.
 */

const okResponse = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

/** Lo que devuelve dolarapi para `casa: "bolsa"` (el MEP). */
const bolsa = {
  moneda: "USD",
  casa: "bolsa",
  nombre: "Bolsa",
  compra: 1509.6,
  venta: 1521.6,
  fechaActualizacion: "2026-08-17T18:58:00.000Z",
};

/** El mismo cuerpo pero SIN la clave `venta`, no con `venta` en undefined. */
function omitVenta(): Record<string, unknown> {
  const resto: Record<string, unknown> = { ...bolsa };
  delete resto.venta;
  return resto;
}

/**
 * Un "ahora" fijo, dos horas después de la cotización del fixture. Todas las
 * llamadas lo pasan explícitamente: sin eso, el test de frescura empezaría a
 * fallar solo cuando la fecha del fixture quedara vieja.
 */
const NOW = new Date("2026-08-17T20:58:00.000Z");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse(bolsa));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // `unstubAllGlobals` NO deshace los `vi.spyOn`. Sin esto, un test que espía
  // `AbortSignal.timeout` y falla en la aserción deja el global parchado para
  // todo lo que venga después: el restore que vive al final del test no corre
  // cuando la aserción tira.
  vi.restoreAllMocks();
});

describe("quoteUsdToArs", () => {
  /**
   * Se usa `venta`, no `compra`. Para quedar entero en dólares hay que mirar a
   * cuánto se COMPRA un dólar en el mercado, que es el precio de venta. Tomar
   * `compra` cobraría de menos en cada suscripción.
   */
  it("toma el precio de VENTA, no el de compra", async () => {
    const quote = await quoteUsdToArs(NOW);

    expect(quote.ok && quote.value.rate).toBe(1521.6);
  });

  it("deja registrada la fuente y el momento de la cotización", async () => {
    const quote = await quoteUsdToArs(NOW);

    expect(quote.ok && quote.value.source).toBe("dolarapi:bolsa");
    expect(quote.ok && quote.value.quotedAt.toISOString()).toBe(
      "2026-08-17T18:58:00.000Z",
    );
  });

  // El MEP en esta API se llama `bolsa`. `/v1/dolares/mep` no existe: da 404.
  it("consulta el dólar bolsa", async () => {
    await quoteUsdToArs(NOW);

    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "dolarapi.com/v1/dolares/bolsa",
    );
  });

  /**
   * Se prueba el VALOR del corte y que el signal LLEGUE al fetch. Con sólo lo
   * primero, borrar `signal:` de las opciones y dejar la llamada suelta a
   * `AbortSignal.timeout` mantenía el test en verde con la request ya
   * incancelable. El restore va en el `afterEach`, no acá: si la aserción
   * falla, un restore al final del test no corre.
   */
  it("corta a los 5 segundos, y el signal llega al fetch", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await quoteUsdToArs(NOW);

    expect(timeout).toHaveBeenCalledWith(5000);
    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(options.signal).toBe(timeout.mock.results[0]!.value);
  });

  /**
   * `no-store` explícito. En Next 16 el default de `fetch` es contextual —
   * cachea lo pedido antes de una API de request-time— así que sin esto la
   * frescura del número que se cobra dependería del orden en que lo llamaron.
   */
  it("pide la cotización sin cache", async () => {
    await quoteUsdToArs(NOW);

    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(options.cache).toBe("no-store");
  });

  it("una respuesta HTTP con error no da cotización", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  /**
   * FALLA CERRADO. Un `venta` ausente, cero, negativo o que no es número no
   * puede convertirse en un precio: cobraría cualquier cosa. Preferimos no
   * poder cobrar antes que cobrar un número inventado.
   */
  it.each([
    // Se pasan cuerpos COMPLETOS y no parches: un `{...bolsa, ...{}}` para el
    // caso ausente no borra nada, deja el `venta` bueno y el test pasa sin
    // probar lo que dice probar.
    ["ausente", omitVenta()],
    ["cero", { ...bolsa, venta: 0 }],
    ["negativo", { ...bolsa, venta: -1500 }],
    ["texto", { ...bolsa, venta: "1521,60" }],
    ["nulo", { ...bolsa, venta: null }],
  ])("un precio de venta %s no da cotización", async (_caso, body) => {
    fetchMock.mockResolvedValue(okResponse(body));

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  /**
   * Sin fecha no hay cotización auditable: la base exige tasa, fuente y fecha
   * juntas o ninguna (`subscriptions_fx_complete`), así que dejar pasar una
   * cotización sin fecha rompería el insert más adelante y más lejos.
   */
  it("sin fecha de actualización no da cotización", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ...bolsa, fechaActualizacion: undefined }),
    );

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  /**
   * Caso distinto del anterior aunque se parezcan: una fecha AUSENTE la frena
   * el chequeo de tipo, pero una fecha que es texto y no se puede parsear
   * llega hasta el `new Date()` y sale como `Invalid Date`. Sin este test esa
   * rama nunca se ejecuta.
   */
  it("una fecha que no se puede leer tampoco da cotización", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ...bolsa, fechaActualizacion: "ayer a la tarde" }),
    );

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  /**
   * LA PROTECCIÓN QUE FALTABA. Un número positivo pero absurdo pasaba todos
   * los chequeos y se convertía en el monto cobrado. La banda no pretende
   * seguir al mercado —para eso tendría que actualizarse sola, que es el
   * problema que evita— sino atajar corrupción: un `1` o un `1e9` no son
   * cotizaciones, son basura.
   */
  it.each([
    ["ridículamente baja", 1],
    ["ridículamente alta", 1_000_000_000],
    ["justo debajo del piso", 99.99],
    ["justo encima del techo", 10_000_000.01],
  ])("una cotización %s no da cotización", async (_caso, venta) => {
    fetchMock.mockResolvedValue(okResponse({ ...bolsa, venta }));

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  /**
   * Los bordes se ACEPTAN. Sin este test, invertir un `<` por un `<=` al
   * editar la banda no rompería nada y el rango real quedaría corrido.
   */
  it.each([
    ["el piso exacto", 100],
    ["el techo exacto", 10_000_000],
  ])("una cotización en %s sí se acepta", async (_caso, venta) => {
    fetchMock.mockResolvedValue(okResponse({ ...bolsa, venta }));

    const quote = await quoteUsdToArs(NOW);
    expect(quote.ok && quote.value.rate).toBe(venta);
  });

  it("un cuerpo que no es un objeto no da cotización", async () => {
    fetchMock.mockResolvedValue(okResponse(null));

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  it("un cuerpo que no es JSON legible no da cotización", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);

    expect((await quoteUsdToArs(NOW)).ok).toBe(false);
  });

  it("si el servicio no responde devuelve error, no explota", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(quoteUsdToArs(NOW)).resolves.toMatchObject({ ok: false });
  });

  /**
   * El corte de tiempo tiene que TERMINAR en error, no sólo existir. Un
   * `AbortSignal` presente pero que nadie atiende dejaría el checkout colgado
   * igual.
   */
  it("un llamado abortado por tiempo devuelve error", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      }),
    );

    await expect(quoteUsdToArs(NOW)).resolves.toMatchObject({ ok: false });
  });

  /**
   * LOS DOS FALLOS NO SON EL MISMO PROBLEMA, y el código que llame a esto
   * tiene que poder distinguirlos: "no contestó" se reintenta, "contestó
   * cualquier cosa" no se arregla reintentando y hay que ir a mirarlo.
   *
   * Sin estos tests el discriminador no está probado y colapsarlo de nuevo en
   * un solo código no rompería nada.
   */
  it.each([
    ["la red se cayó", () => fetchMock.mockRejectedValue(new Error("down"))],
    [
      "el servicio devolvió 503",
      () => fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response),
    ],
  ])("%s es un fallo TRANSITORIO", async (_caso, arrange) => {
    arrange();

    const quote = await quoteUsdToArs(NOW);
    expect(!quote.ok && quote.error.code).toBe("fx_unreachable");
  });

  it.each([
    ["un campo renombrado", { ...bolsa, venta: undefined }],
    ["una tasa fuera de escala", { ...bolsa, venta: 3 }],
    ["una fecha ilegible", { ...bolsa, fechaActualizacion: "cuando sea" }],
  ])("%s es un fallo de CONTRATO", async (_caso, body) => {
    fetchMock.mockResolvedValue(okResponse(body));

    const quote = await quoteUsdToArs(NOW);
    expect(!quote.ok && quote.error.code).toBe("fx_bad_response");
  });

  /**
   * Que la fecha se LEA no quiere decir que sirva. Un servicio congelado
   * devuelve una cotización de hace meses con formato impecable, y esa tasa
   * vieja se cobraría como si fuera de hoy.
   */
  it.each([
    ["de hace cuatro días", "2026-08-13T18:58:00.000Z"],
    ["adelantada dos días", "2026-08-19T20:58:00.000Z"],
  ])("una cotización %s no sirve", async (_caso, fechaActualizacion) => {
    fetchMock.mockResolvedValue(okResponse({ ...bolsa, fechaActualizacion }));

    const quote = await quoteUsdToArs(NOW);
    expect(!quote.ok && quote.error.code).toBe("fx_bad_response");
  });

  /**
   * El margen tiene que cubrir un fin de semana con el mercado cerrado: la
   * fecha del dólar bolsa no se mueve sábado ni domingo, y un lunes temprano
   * la última cotización real es del viernes.
   */
  it("una cotización de dos días sí sirve", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ...bolsa, fechaActualizacion: "2026-08-15T18:58:00.000Z" }),
    );

    expect((await quoteUsdToArs(NOW)).ok).toBe(true);
  });

  /**
   * Los bordes EXACTOS de la frescura, por la misma razón por la que están los
   * de la banda de plausibilidad: sin ellos, cambiar un `>` por un `>=` al
   * editar los márgenes correría la ventana real un milisegundo sin romper
   * nada. Los casos de más arriba están lejos del borde y no lo notarían.
   *
   * `NOW` es 2026-08-17T20:58Z, así que el límite viejo cae en el 14 a la
   * misma hora y el futuro en las 21:58 del mismo día.
   */
  it.each([
    ["justo en el límite de edad", "2026-08-14T20:58:00.000Z"],
    ["justo en el límite de adelanto", "2026-08-17T21:58:00.000Z"],
  ])("una cotización %s todavía sirve", async (_caso, fechaActualizacion) => {
    fetchMock.mockResolvedValue(okResponse({ ...bolsa, fechaActualizacion }));

    expect((await quoteUsdToArs(NOW)).ok).toBe(true);
  });

  it.each([
    ["un milisegundo más vieja", "2026-08-14T20:57:59.999Z"],
    ["un milisegundo más adelantada", "2026-08-17T21:58:00.001Z"],
  ])("una cotización %s ya no sirve", async (_caso, fechaActualizacion) => {
    fetchMock.mockResolvedValue(okResponse({ ...bolsa, fechaActualizacion }));

    const quote = await quoteUsdToArs(NOW);
    expect(!quote.ok && quote.error.code).toBe("fx_bad_response");
  });
});
