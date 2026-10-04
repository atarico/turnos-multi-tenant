import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok, type Result } from "@/core/result";
import type { MpPayment } from "@/modules/payments/application/mp-payments";
import { notifyToken } from "@/modules/payments/domain/notify-token";

import { POST } from "./route";

/**
 * Tests del webhook de pagos de los NEGOCIOS (distinto del de la plataforma).
 *
 * Las anclas de confianza son DOS y se prueban por separado: el token `k` de la
 * URL (corta el abuso anónimo ANTES de tocar nada) y el re-fetch del pago con el
 * token del negocio. La firma `x-signature` no decide nada: no está claro que
 * Mercado Pago firme las URLs por preferencia, y un 401 podría tirar avisos
 * legítimos.
 */

const TENANT = "5b1f5a3e-6f0c-4c9a-9a54-1c5b6a8f2d10";
const OTHER_TENANT = "9c1f5a3e-6f0c-4c9a-9a54-1c5b6a8f2d99";
const STATE_SECRET = "secreto-de-estado-de-prueba";
const K = notifyToken(STATE_SECRET, TENANT);

let configuredSecret: Result<string> = ok(STATE_SECRET);
vi.mock("@/modules/payments/application/config", () => ({
  stateSecret: () => configuredSecret,
}));

const loadTenantAccessToken = vi.fn<(tenantId: string) => Promise<Result<string>>>();
vi.mock("@/modules/payments/application/mp-accounts", () => ({
  loadTenantAccessToken: (t: string) => loadTenantAccessToken(t),
}));

const fetchPayment = vi.fn<(token: string, id: string) => Promise<Result<MpPayment>>>();
vi.mock("@/modules/payments/application/mp-payments", () => ({
  fetchPayment: (token: string, id: string) => fetchPayment(token, id),
}));

const applyMpPayment = vi.fn<(tenantId: string, payment: MpPayment) => Promise<Result<string>>>();
vi.mock("@/modules/payments/application/sync-booking-payment", () => ({
  applyMpPayment: (t: string, p: MpPayment) => applyMpPayment(t, p),
}));

const payment: MpPayment = {
  id: "555",
  status: "approved",
  statusDetail: "accredited",
  externalReference: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  amountCents: 1000,
  currency: "ARS",
  collectorId: "777",
  approvedAt: "2026-10-04T14:00:00.000Z",
};

function request(options: { query?: string; headers?: Record<string, string>; body?: unknown; raw?: string }): Request {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  return new Request(`https://app.turnos.com/api/webhooks/mercadopago/payments?${options.query ?? ""}`, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(options.body ?? {}),
  });
}

const paymentQuery = `tenant=${TENANT}&k=${K}&data.id=555&type=payment`;

function expectNoWork() {
  expect(loadTenantAccessToken).not.toHaveBeenCalled();
  expect(fetchPayment).not.toHaveBeenCalled();
  expect(applyMpPayment).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  configuredSecret = ok(STATE_SECRET);
  loadTenantAccessToken.mockResolvedValue(ok("TENANT-TOKEN"));
  fetchPayment.mockResolvedValue(ok(payment));
  applyMpPayment.mockResolvedValue(ok("applied"));
});

describe("el token k de la URL", () => {
  it("con un k válido: re-lee el pago con el token del negocio y lo aplica", async () => {
    const response = await POST(request({ query: paymentQuery }));

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(loadTenantAccessToken).toHaveBeenCalledWith(TENANT);
    expect(fetchPayment).toHaveBeenCalledWith("TENANT-TOKEN", "555");
    expect(applyMpPayment).toHaveBeenCalledWith(TENANT, payment);
  });

  it("sin k: 200 y NO hace ningún trabajo", async () => {
    const response = await POST(request({ query: `tenant=${TENANT}&data.id=555&type=payment` }));

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("con un k equivocado: 200 y NO hace ningún trabajo", async () => {
    const response = await POST(
      request({ query: `tenant=${TENANT}&k=${notifyToken("otro-secreto", TENANT)}&data.id=555&type=payment` }),
    );

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("con el k de OTRO negocio: 200 y NO hace ningún trabajo", async () => {
    const response = await POST(
      request({
        query: `tenant=${TENANT}&k=${notifyToken(STATE_SECRET, OTHER_TENANT)}&data.id=555&type=payment`,
      }),
    );

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("con basura en k: 200 y NO hace ningún trabajo", async () => {
    const response = await POST(request({ query: `tenant=${TENANT}&k=%%%&data.id=555&type=payment` }));

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("sin PAYMENTS_STATE_SECRET no hay con qué verificar: 200 sin trabajo", async () => {
    configuredSecret = err(appError("payments_not_configured", "x"));

    const response = await POST(request({ query: paymentQuery }));

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("el k se chequea antes de leer el cuerpo y de mirar el tipo", async () => {
    const response = await POST(request({ query: `tenant=${TENANT}&type=payment`, raw: "{no es json" }));

    expect(response.status).toBe(200);
    expectNoWork();
  });
});

describe("type=payment", () => {
  it("la firma NO decide nada: una x-signature inventada no devuelve 401", async () => {
    const response = await POST(
      request({
        query: paymentQuery,
        headers: { "x-signature": "ts=1,v1=deadbeef", "x-request-id": "r" },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchPayment).toHaveBeenCalled();
  });

  it("acepta el formato viejo (?topic=payment&id=…)", async () => {
    const response = await POST(request({ query: `tenant=${TENANT}&k=${K}&topic=payment&id=555` }));

    expect(response.status).toBe(200);
    expect(fetchPayment).toHaveBeenCalledWith("TENANT-TOKEN", "555");
  });

  it("toma type y data.id del cuerpo si no vienen en la query", async () => {
    const response = await POST(
      request({ query: `tenant=${TENANT}&k=${K}`, body: { type: "payment", data: { id: "555" } } }),
    );

    expect(response.status).toBe(200);
    expect(fetchPayment).toHaveBeenCalledWith("TENANT-TOKEN", "555");
  });

  it("el `id` del CUERPO es el id de la notificación, no del pago: no se usa", async () => {
    const response = await POST(
      request({ query: `tenant=${TENANT}&k=${K}&type=payment`, body: { id: 987654321 } }),
    );

    expect(response.status).toBe(200);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("la query manda sobre el cuerpo para el id del pago", async () => {
    await POST(request({ query: paymentQuery, body: { data: { id: "999" } } }));

    expect(fetchPayment).toHaveBeenCalledWith("TENANT-TOKEN", "555");
  });

  it.each([
    ["sin tenant", `k=${K}&data.id=555&type=payment`],
    ["un tenant que no es uuid", `tenant=nope&k=${K}&data.id=555&type=payment`],
    ["sin id de pago", `tenant=${TENANT}&k=${K}&type=payment`],
  ])("%s: 200 y no se toca nada", async (_name, query) => {
    const response = await POST(request({ query }));

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it.each(["not_connected", "broken", "decrypt_failed", "payments_not_configured"])(
    "negocio sin cuenta usable (%s): 200 y no se llama a Mercado Pago",
    async (code) => {
      loadTenantAccessToken.mockResolvedValue(err(appError(code, "x")));

      const response = await POST(request({ query: paymentQuery }));

      expect(response.status).toBe(200);
      expect(fetchPayment).not.toHaveBeenCalled();
    },
  );

  it("un error transitorio leyendo la cuenta es 500 (que Mercado Pago reintente)", async () => {
    loadTenantAccessToken.mockResolvedValue(err(appError("account_load_failed", "x")));

    const response = await POST(request({ query: paymentQuery }));

    expect(response.status).toBe(500);
  });

  describe("el re-fetch del pago", () => {
    it.each([
      ["mp_unreachable", undefined],
      ["mp_rate_limited", undefined],
      ["mp_rejected", "not_found"],
    ])("%s (%s) pide reintento: 500", async (code, cause) => {
      fetchPayment.mockResolvedValue(err(appError(code, "x", cause)));

      const response = await POST(request({ query: paymentQuery }));

      expect(response.status).toBe(500);
      expect(applyMpPayment).not.toHaveBeenCalled();
    });

    it.each([
      ["mp_unauthorized", undefined],
      ["mp_rejected", undefined],
      ["mp_bad_response", undefined],
    ])("%s es permanente: 200", async (code, cause) => {
      fetchPayment.mockResolvedValue(err(appError(code, "x", cause)));

      const response = await POST(request({ query: paymentQuery }));

      expect(response.status).toBe(200);
      expect(applyMpPayment).not.toHaveBeenCalled();
    });
  });

  it("un error aplicando el pago es 500", async () => {
    applyMpPayment.mockResolvedValue(err(appError("payment_apply_failed", "x")));

    const response = await POST(request({ query: paymentQuery }));

    expect(response.status).toBe(500);
  });

  it.each(["ignored", "duplicate"])("el resultado '%s' es 200", async (outcome) => {
    applyMpPayment.mockResolvedValue(ok(outcome));

    const response = await POST(request({ query: paymentQuery }));

    expect(response.status).toBe(200);
  });

  it("una excepción inesperada es 500 con el cuerpo vacío", async () => {
    applyMpPayment.mockRejectedValue(new Error("boom con el secreto del negocio"));

    const response = await POST(request({ query: paymentQuery }));

    expect(response.status).toBe(500);
    expect(response.body).toBeNull();
  });

  it("no loguea el token ni el mensaje de la excepción", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    applyMpPayment.mockRejectedValue(new Error("boom TENANT-TOKEN"));
    fetchPayment.mockResolvedValueOnce(err(appError("mp_unreachable", "TENANT-TOKEN")));

    await POST(request({ query: paymentQuery }));
    await POST(request({ query: paymentQuery }));

    expect(JSON.stringify(spy.mock.calls)).not.toContain("TENANT-TOKEN");
    spy.mockRestore();
  });
});

describe("otros tipos", () => {
  it("mp-connect se ignora como cualquier tipo desconocido: 200 y no se toca nada", async () => {
    const response = await POST(
      request({
        query: `tenant=${TENANT}&k=${K}&type=mp-connect`,
        body: { type: "mp-connect", action: "application.deauthorized", user_id: 777 },
      }),
    );

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("un tipo desconocido es 200 y no se toca nada", async () => {
    const response = await POST(request({ query: `tenant=${TENANT}&k=${K}&data.id=1&type=merchant_order` }));

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("sin tipo: 200", async () => {
    const response = await POST(request({ query: `tenant=${TENANT}&k=${K}` }));

    expect(response.status).toBe(200);
    expectNoWork();
  });

  it("un cuerpo ilegible no rompe: se decide con la query", async () => {
    const response = await POST(request({ query: paymentQuery, raw: "{no es json" }));

    expect(response.status).toBe(200);
    expect(fetchPayment).toHaveBeenCalled();
  });
});
