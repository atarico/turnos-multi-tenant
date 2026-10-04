import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok, type Result } from "@/core/result";

import { startBookingPayment, type HeldBooking } from "./start-booking-payment";

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

const loadTenantAccessToken = vi.fn<(tenantId: string) => Promise<Result<string>>>();
const markTenantMpAccountBroken = vi.fn<(tenantId: string) => Promise<Result<void>>>();
vi.mock("./mp-accounts", () => ({
  loadTenantAccessToken: (t: string) => loadTenantAccessToken(t),
  markTenantMpAccountBroken: (t: string) => markTenantMpAccountBroken(t),
}));

const createCheckoutPreference = vi.fn<(...a: unknown[]) => Promise<Result<unknown>>>();
vi.mock("./checkout-preference", () => ({
  createCheckoutPreference: (...a: unknown[]) => createCheckoutPreference(...a),
}));

const rpc = vi.fn<(fn: string, args: unknown) => Promise<{ error: unknown }>>();
const insert = vi.fn<(row: unknown) => Promise<{ error: unknown }>>();
const from = vi.fn();
let adminFailure: Error | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return {
      rpc: (fn: string, args: unknown) => rpc(fn, args),
      from: (table: string) => {
        from(table);
        return { insert: (row: unknown) => insert(row) };
      },
    };
  },
}));

const booking: HeldBooking = {
  id: "b-1",
  tenant_id: "t-1",
  service_name: "Corte",
  price_cents: 150000,
  currency: "ARS",
  customer_name: "Ana",
  customer_email: "ana@correo.com",
  payment_expires_at: "2026-10-04T12:15:00.000Z",
};
const context = { slug: "negocio" };

const INIT_POINT = "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=p1";

const rpcCalls = () => rpc.mock.calls.map(([fn]) => fn);

beforeEach(() => {
  vi.clearAllMocks();
  adminFailure = null;
  loadTenantAccessToken.mockResolvedValue(ok("TENANT-TOKEN"));
  markTenantMpAccountBroken.mockResolvedValue(ok(undefined));
  createCheckoutPreference.mockResolvedValue(ok({ preferenceId: "p1", initPoint: INIT_POINT }));
  rpc.mockResolvedValue({ error: null });
  insert.mockResolvedValue({ error: null });
});

describe("startBookingPayment: éxito", () => {
  it("registra el pago pendiente y devuelve el init_point", async () => {
    const result = await startBookingPayment(booking, context);

    expect(result).toEqual({ ok: true, value: { kind: "redirect", url: INIT_POINT } });
    expect(from).toHaveBeenCalledWith("booking_payments");
    expect(insert).toHaveBeenCalledWith({
      booking_id: "b-1",
      tenant_id: "t-1",
      mp_preference_id: "p1",
      status: "pending",
      amount_cents: 150000,
      currency: "ARS",
    });
    // El hold queda como está: lo resuelve el pago (T5) o el vencimiento.
    expect(rpc).not.toHaveBeenCalled();
    expect(markTenantMpAccountBroken).not.toHaveBeenCalled();
  });

  it("arma la preferencia con los datos del turno y el token del negocio", async () => {
    await startBookingPayment(booking, context);

    expect(loadTenantAccessToken).toHaveBeenCalledWith("t-1");
    expect(createCheckoutPreference).toHaveBeenCalledWith("TENANT-TOKEN", {
      title: "Corte",
      amountCents: 150000,
      currency: "ARS",
      bookingId: "b-1",
      tenantId: "t-1",
      slug: "negocio",
      appUrl: "https://app.test",
      expiresAt: new Date("2026-10-04T12:15:00.000Z"),
      payer: { name: "Ana", email: "ana@correo.com" },
    });
  });
});

describe("startBookingPayment: falla de la CUENTA", () => {
  const accountFailures: [string, () => void][] = [
    ["not_connected", () => loadTenantAccessToken.mockResolvedValue(err(appError("not_connected", "x")))],
    ["broken", () => loadTenantAccessToken.mockResolvedValue(err(appError("broken", "x")))],
    ["decrypt_failed", () => loadTenantAccessToken.mockResolvedValue(err(appError("decrypt_failed", "x")))],
    ["mp_unauthorized", () => createCheckoutPreference.mockResolvedValue(err(appError("mp_unauthorized", "x")))],
  ];

  it.each(accountFailures)(
    "%s: marca la cuenta rota y confirma ESTE turno sin pago",
    async (_code, arrange) => {
      arrange();

      const result = await startBookingPayment(booking, context);

      expect(result).toEqual({ ok: true, value: { kind: "confirmed_without_payment" } });
      expect(markTenantMpAccountBroken).toHaveBeenCalledWith("t-1");
      expect(rpc).toHaveBeenCalledWith("release_payment_hold_without_payment", {
        p_booking_id: "b-1",
      });
      expect(rpcCalls()).not.toContain("cancel_payment_hold");
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it("si marcar la cuenta falla, igual confirma el turno sin pago", async () => {
    loadTenantAccessToken.mockResolvedValue(err(appError("broken", "x")));
    markTenantMpAccountBroken.mockResolvedValue(err(appError("account_update_failed", "x")));

    const result = await startBookingPayment(booking, context);

    expect(result).toEqual({ ok: true, value: { kind: "confirmed_without_payment" } });
    expect(rpcCalls()).toEqual(["release_payment_hold_without_payment"]);
  });

  /**
   * Falta configuración de la PLATAFORMA, no de la cuenta: no es culpa del
   * negocio, así que no se le marca la conexión como rota, pero tampoco se
   * le bloquea la agenda — el turno se confirma sin pago, igual que con una
   * cuenta caída.
   */
  it("sin configuración de la plataforma: confirma sin pago y NO marca la cuenta", async () => {
    loadTenantAccessToken.mockResolvedValue(err(appError("payments_not_configured", "x")));

    const result = await startBookingPayment(booking, context);

    expect(result).toEqual({ ok: true, value: { kind: "confirmed_without_payment" } });
    expect(markTenantMpAccountBroken).not.toHaveBeenCalled();
    expect(rpcCalls()).toEqual(["release_payment_hold_without_payment"]);
  });

  it("sin configuración al armar la preferencia: tampoco marca la cuenta", async () => {
    createCheckoutPreference.mockResolvedValue(err(appError("payments_not_configured", "x")));

    const result = await startBookingPayment(booking, context);

    expect(result).toEqual({ ok: true, value: { kind: "confirmed_without_payment" } });
    expect(markTenantMpAccountBroken).not.toHaveBeenCalled();
  });

  it("si el release falla (el hold ya venció), cancela el hold y pide reintentar", async () => {
    loadTenantAccessToken.mockResolvedValue(err(appError("broken", "x")));
    rpc.mockImplementation(async (fn) =>
      fn === "release_payment_hold_without_payment"
        ? { error: { message: "El hold de pago ya venció" } }
        : { error: null },
    );

    const result = await startBookingPayment(booking, context);

    expect(result).toMatchObject({ ok: false, error: { code: "payment_start_failed" } });
    expect(rpcCalls()).toEqual([
      "release_payment_hold_without_payment",
      "cancel_payment_hold",
    ]);
  });
});

describe("startBookingPayment: falla TRANSITORIA", () => {
  const transient: [string, () => void][] = [
    ["mp_unreachable", () => createCheckoutPreference.mockResolvedValue(err(appError("mp_unreachable", "x")))],
    ["mp_bad_response", () => createCheckoutPreference.mockResolvedValue(err(appError("mp_bad_response", "x")))],
    ["mp_rejected", () => createCheckoutPreference.mockResolvedValue(err(appError("mp_rejected", "x")))],
    ["account_load_failed", () => loadTenantAccessToken.mockResolvedValue(err(appError("account_load_failed", "x")))],
  ];

  it.each(transient)(
    "%s: cancela el hold y pide reintentar, SIN regalar el turno",
    async (_code, arrange) => {
      arrange();

      const result = await startBookingPayment(booking, context);

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "payment_start_failed",
          message: expect.stringContaining("probá de nuevo"),
        },
      });
      expect(rpcCalls()).toEqual(["cancel_payment_hold"]);
      expect(rpc).toHaveBeenCalledWith("cancel_payment_hold", { p_booking_id: "b-1" });
      expect(markTenantMpAccountBroken).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it("si no se puede registrar el pago, cancela el hold (el cliente nunca recibe la URL)", async () => {
    insert.mockResolvedValue({ error: { message: "boom" } });

    const result = await startBookingPayment(booking, context);

    expect(result).toMatchObject({ ok: false, error: { code: "payment_start_failed" } });
    expect(rpcCalls()).toEqual(["cancel_payment_hold"]);
  });

  it("un hold sin vencimiento no se puede pagar: se cancela", async () => {
    const result = await startBookingPayment({ ...booking, payment_expires_at: null }, context);

    expect(result).toMatchObject({ ok: false, error: { code: "payment_start_failed" } });
    expect(createCheckoutPreference).not.toHaveBeenCalled();
    expect(rpcCalls()).toEqual(["cancel_payment_hold"]);
  });

  it("si el cancel también falla igual devuelve el error de reintento", async () => {
    createCheckoutPreference.mockResolvedValue(err(appError("mp_unreachable", "x")));
    rpc.mockResolvedValue({ error: { message: "boom" } });

    const result = await startBookingPayment(booking, context);

    expect(result).toMatchObject({ ok: false, error: { code: "payment_start_failed" } });
  });
});

describe("startBookingPayment: el cliente admin", () => {
  it("si createAdminClient tira, devuelve un Result y no una excepción", async () => {
    adminFailure = new Error("falta la service-role key");

    const result = await startBookingPayment(booking, context);

    expect(result).toMatchObject({ ok: false, error: { code: "payment_start_failed" } });
  });

  it("no filtra el token en ningún error", async () => {
    createCheckoutPreference.mockResolvedValue(err(appError("mp_unreachable", "TENANT-TOKEN")));
    const result = await startBookingPayment(booking, context);
    // El mensaje que sale es el propio, no el de la capa de abajo.
    expect(JSON.stringify(result)).not.toContain("TENANT-TOKEN");
  });
});
