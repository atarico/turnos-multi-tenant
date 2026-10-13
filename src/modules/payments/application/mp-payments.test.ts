import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPayment, searchPaymentsByExternalReference } from "./mp-payments";

const response = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const BOOKING_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const paymentBody = {
  id: 1234567890,
  status: "approved",
  status_detail: "accredited",
  external_reference: BOOKING_ID,
  transaction_amount: 1500.5,
  currency_id: "ARS",
  collector_id: 98765,
  date_approved: "2026-10-04T10:00:00.000-04:00",
};

let fetchMock: ReturnType<typeof vi.fn>;

function sent() {
  const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
  return { url, options };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => response(200, paymentBody));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("fetchPayment", () => {
  it("normaliza el pago: id como texto, monto en centavos enteros, collector como texto", async () => {
    const result = await fetchPayment("TENANT-TOKEN", "1234567890");

    expect(result).toEqual({
      ok: true,
      value: {
        id: "1234567890",
        status: "approved",
        statusDetail: "accredited",
        externalReference: BOOKING_ID,
        amountCents: 150050,
        currency: "ARS",
        collectorId: "98765",
        approvedAt: "2026-10-04T14:00:00.000Z",
      },
    });
  });

  it("le pega a /v1/payments/{id} con el token DEL NEGOCIO, sin cachear y con timeout", async () => {
    await fetchPayment("TENANT-TOKEN", "1234567890");

    const { url, options } = sent();
    expect(url).toBe("https://api.mercadopago.com/v1/payments/1234567890");
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({ Authorization: "Bearer TENANT-TOKEN" });
    expect(options.cache).toBe("no-store");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("escapa el id en la URL: no se puede colar otro path", async () => {
    await fetchPayment("T", "1/../../x?y=1");

    expect(sent().url).toBe("https://api.mercadopago.com/v1/payments/1%2F..%2F..%2Fx%3Fy%3D1");
  });

  it("el redondeo a centavos es entero aunque el float no lo sea (19.99 → 1999)", async () => {
    fetchMock.mockResolvedValue(response(200, { ...paymentBody, transaction_amount: 19.99 }));

    const result = await fetchPayment("T", "1");

    expect(result.ok && result.value.amountCents).toBe(1999);
  });

  it("acepta collector.id cuando no viene collector_id", async () => {
    const { collector_id: _omit, ...rest } = paymentBody;
    void _omit;
    fetchMock.mockResolvedValue(response(200, { ...rest, collector: { id: 555 } }));

    const result = await fetchPayment("T", "1");

    expect(result.ok && result.value.collectorId).toBe("555");
  });

  it("sin collector ni referencia externa: los deja en null en vez de fallar", async () => {
    const { collector_id: _c, external_reference: _e, ...rest } = paymentBody;
    void _c;
    void _e;
    fetchMock.mockResolvedValue(response(200, rest));

    const result = await fetchPayment("T", "1");

    expect(result.ok && result.value).toMatchObject({ collectorId: null, externalReference: null });
  });

  it.each([401, 403])("%i es mp_unauthorized", async (status) => {
    fetchMock.mockResolvedValue(response(status, {}));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_unauthorized");
  });

  it("429 es mp_rate_limited (hay que reintentar, no es un rechazo)", async () => {
    fetchMock.mockResolvedValue(response(429, {}));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_rate_limited");
  });

  it("date_approved se normaliza a ISO UTC; sin él o ilegible queda en null", async () => {
    const { date_approved: _d, ...rest } = paymentBody;
    void _d;
    fetchMock.mockResolvedValueOnce(response(200, rest));
    const missing = await fetchPayment("T", "1");
    fetchMock.mockResolvedValueOnce(response(200, { ...paymentBody, date_approved: "ayer" }));
    const garbage = await fetchPayment("T", "1");
    fetchMock.mockResolvedValueOnce(response(200, { ...paymentBody, date_approved: null }));
    const nulled = await fetchPayment("T", "1");

    for (const r of [missing, garbage, nulled]) {
      expect(r.ok && r.value.approvedAt).toBeNull();
    }
  });

  it("404 es mp_rejected con 'not_found' en la causa", async () => {
    fetchMock.mockResolvedValue(response(404, {}));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_rejected");
    expect(result.ok === false && result.error.cause).toBe("not_found");
  });

  it("otro 4xx es mp_rejected", async () => {
    fetchMock.mockResolvedValue(response(400, {}));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_rejected");
    expect(result.ok === false && result.error.cause).toBeUndefined();
  });

  it("5xx es mp_unreachable (transitorio)", async () => {
    fetchMock.mockResolvedValue(response(503, {}));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_unreachable");
  });

  it("un fetch que tira (red, timeout) es mp_unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_unreachable");
  });

  it("2xx con un cuerpo que no es JSON es mp_bad_response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("no json");
      },
    } as unknown as Response);

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_bad_response");
  });

  it.each([
    ["sin status", { ...paymentBody, status: undefined }],
    ["sin id", { ...paymentBody, id: undefined }],
    ["monto no numérico", { ...paymentBody, transaction_amount: "mucho" }],
    ["sin moneda", { ...paymentBody, currency_id: undefined }],
    ["un array", []],
  ])("2xx con el esquema roto (%s) es mp_bad_response", async (_name, body) => {
    fetchMock.mockResolvedValue(response(200, body));

    const result = await fetchPayment("T", "1");

    expect(result.ok === false && result.error.code).toBe("mp_bad_response");
  });

  it("ningún error incluye el token ni el cuerpo de la respuesta", async () => {
    fetchMock.mockResolvedValue(response(500, { secret: "TENANT-TOKEN-LEAK" }));

    const result = await fetchPayment("TENANT-TOKEN-LEAK", "1");

    expect(JSON.stringify(result)).not.toContain("TENANT-TOKEN-LEAK");
  });
});

describe("searchPaymentsByExternalReference", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(response(200, { results: [paymentBody, { ...paymentBody, id: 2 }] }));
  });

  it("busca por external_reference, del más reciente al más viejo", async () => {
    await searchPaymentsByExternalReference("TENANT-TOKEN", BOOKING_ID);

    const { url, options } = sent();
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.mercadopago.com/v1/payments/search");
    expect(parsed.searchParams.get("external_reference")).toBe(BOOKING_ID);
    expect(parsed.searchParams.get("sort")).toBe("date_created");
    expect(parsed.searchParams.get("criteria")).toBe("desc");
    expect(options.headers).toMatchObject({ Authorization: "Bearer TENANT-TOKEN" });
  });

  it("devuelve los pagos normalizados, en el orden que mandó Mercado Pago", async () => {
    const result = await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(result.ok && result.value.map((p) => p.id)).toEqual(["1234567890", "2"]);
  });

  it("sin resultados: lista vacía", async () => {
    fetchMock.mockResolvedValue(response(200, { results: [] }));

    const result = await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("un resultado con el esquema roto es mp_bad_response (no se aplica a medias)", async () => {
    fetchMock.mockResolvedValue(response(200, { results: [{ id: 1 }] }));

    const result = await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(result.ok === false && result.error.code).toBe("mp_bad_response");
  });

  it("sin `results`: mp_bad_response", async () => {
    fetchMock.mockResolvedValue(response(200, {}));

    const result = await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(result.ok === false && result.error.code).toBe("mp_bad_response");
  });

  it("usa el timeout que se le pide (el retorno del checkout tiene un presupuesto corto)", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");

    await searchPaymentsByExternalReference("T", BOOKING_ID, { timeoutMs: 2500 });
    await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([2500, 10_000]);
    spy.mockRestore();
  });

  it("429 es mp_rate_limited", async () => {
    fetchMock.mockResolvedValue(response(429, {}));

    const result = await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(result.ok === false && result.error.code).toBe("mp_rate_limited");
  });

  it("mismos códigos de error que fetchPayment: 401, 5xx y red", async () => {
    fetchMock.mockResolvedValueOnce(response(401, {}));
    const unauthorized = await searchPaymentsByExternalReference("T", BOOKING_ID);
    fetchMock.mockResolvedValueOnce(response(500, {}));
    const down = await searchPaymentsByExternalReference("T", BOOKING_ID);
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const network = await searchPaymentsByExternalReference("T", BOOKING_ID);

    expect(unauthorized.ok === false && unauthorized.error.code).toBe("mp_unauthorized");
    expect(down.ok === false && down.error.code).toBe("mp_unreachable");
    expect(network.ok === false && network.error.code).toBe("mp_unreachable");
  });
});
