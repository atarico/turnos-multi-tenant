import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCheckoutPreference } from "./checkout-preference";

const response = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const okBody = {
  id: "123-pref",
  init_point: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123-pref",
  sandbox_init_point: "https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=123-pref",
};

const input = {
  title: "Corte de pelo",
  amountCents: 150050,
  currency: "ARS",
  bookingId: "b-1",
  tenantId: "t-1",
  slug: "negocio",
  appUrl: "https://app.test",
  expiresAt: new Date("2026-10-04T12:15:00.000Z"),
  payer: { name: "Ana", email: "ana@correo.com" },
};

let fetchMock: ReturnType<typeof vi.fn>;

function sent() {
  const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
  return { url, options, body: JSON.parse(String(options.body)) };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => response(201, okBody));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("createCheckoutPreference", () => {
  it("devuelve el id y el init_point de la preferencia", async () => {
    const result = await createCheckoutPreference("TENANT-TOKEN", input);

    expect(result).toEqual({
      ok: true,
      value: { preferenceId: "123-pref", initPoint: okBody.init_point },
    });
  });

  it("le pega a /checkout/preferences con el token DEL NEGOCIO, sin cachear y con timeout", async () => {
    await createCheckoutPreference("TENANT-TOKEN", input);

    const { url, options } = sent();
    expect(url).toBe("https://api.mercadopago.com/checkout/preferences");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer TENANT-TOKEN",
      "Content-Type": "application/json",
    });
    expect(options.cache).toBe("no-store");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("arma el cuerpo EXACTO del diseño de T4", async () => {
    await createCheckoutPreference("TENANT-TOKEN", input);

    expect(sent().body).toEqual({
      items: [
        { title: "Corte de pelo", quantity: 1, unit_price: 1500.5, currency_id: "ARS" },
      ],
      external_reference: "b-1",
      notification_url: "https://app.test/api/webhooks/mercadopago/payments?tenant=t-1",
      back_urls: {
        success: "https://app.test/negocio/reserva/b-1",
        failure: "https://app.test/negocio/reserva/b-1",
        pending: "https://app.test/negocio/reserva/b-1",
      },
      auto_return: "approved",
      binary_mode: true,
      expires: true,
      expiration_date_to: "2026-10-04T12:15:00.000Z",
      payment_methods: {
        excluded_payment_types: [{ id: "ticket" }, { id: "atm" }],
      },
      payer: { name: "Ana", email: "ana@correo.com" },
    });
  });

  it("convierte centavos a un número con 2 decimales sin error de float", async () => {
    await createCheckoutPreference("T", { ...input, amountCents: 1999 });
    expect(sent().body.items[0].unit_price).toBe(19.99);
  });

  it("omite el email del pagador cuando la reserva no lo tiene", async () => {
    await createCheckoutPreference("T", { ...input, payer: { name: "Ana", email: null } });
    expect(sent().body.payer).toEqual({ name: "Ana" });
  });

  it.each([401, 403])("un %s es una falla de la CUENTA: mp_unauthorized", async (status) => {
    fetchMock.mockResolvedValue(response(status, { message: "invalid token" }));
    const result = await createCheckoutPreference("T", input);
    expect(result).toMatchObject({ ok: false, error: { code: "mp_unauthorized" } });
  });

  it("otro 4xx es mp_rejected", async () => {
    fetchMock.mockResolvedValue(response(400, { message: "bad" }));
    const result = await createCheckoutPreference("T", input);
    expect(result).toMatchObject({ ok: false, error: { code: "mp_rejected" } });
  });

  it("un 5xx es mp_unreachable (transitorio)", async () => {
    fetchMock.mockResolvedValue(response(503, {}));
    const result = await createCheckoutPreference("T", input);
    expect(result).toMatchObject({ ok: false, error: { code: "mp_unreachable" } });
  });

  it("un error de red o un timeout es mp_unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await createCheckoutPreference("T", input);
    expect(result).toMatchObject({ ok: false, error: { code: "mp_unreachable" } });
  });

  it.each([
    ["sin id", { init_point: okBody.init_point }],
    ["sin init_point", { id: "x" }],
    ["init_point que no es una URL", { id: "x", init_point: "no-es-url" }],
  ])("una respuesta 2xx %s es mp_bad_response", async (_label, body) => {
    fetchMock.mockResolvedValue(response(201, body));
    const result = await createCheckoutPreference("T", input);
    expect(result).toMatchObject({ ok: false, error: { code: "mp_bad_response" } });
  });

  it("un cuerpo que no es JSON es mp_bad_response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => {
        throw new SyntaxError("x");
      },
    } as unknown as Response);
    const result = await createCheckoutPreference("T", input);
    expect(result).toMatchObject({ ok: false, error: { code: "mp_bad_response" } });
  });

  it("los errores no repiten el token ni lo que contestó Mercado Pago", async () => {
    fetchMock.mockResolvedValue(response(401, { message: "token TENANT-TOKEN invalid" }));
    const result = await createCheckoutPreference("TENANT-TOKEN", input);
    expect(JSON.stringify(result)).not.toContain("TENANT-TOKEN");
  });
});
