import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok, type Result } from "@/core/result";

import type { MpPayment } from "./mp-payments";
import { applyMpPayment, syncBookingPaymentFromReturn } from "./sync-booking-payment";

const loadTenantAccessToken = vi.fn<(tenantId: string) => Promise<Result<string>>>();
vi.mock("./mp-accounts", () => ({
  loadTenantAccessToken: (t: string) => loadTenantAccessToken(t),
}));

const searchPayments = vi.fn<(...a: unknown[]) => Promise<Result<MpPayment[]>>>();
vi.mock("./mp-payments", () => ({
  searchPaymentsByExternalReference: (...a: unknown[]) => searchPayments(...a),
}));

const rpc = vi.fn<(fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>();
const maybeSingle = vi.fn<() => Promise<{ data: unknown; error: unknown }>>();
const eq = vi.fn();
const from = vi.fn();
let adminFailure: Error | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return {
      rpc: (fn: string, args: unknown) => rpc(fn, args),
      from: (table: string) => {
        from(table);
        return {
          select: () => ({
            eq: (col: string, value: unknown) => {
              eq(col, value);
              return { maybeSingle: () => maybeSingle() };
            },
          }),
        };
      },
    };
  },
}));

const BOOKING_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const payment: MpPayment = {
  id: "999",
  status: "approved",
  statusDetail: "accredited",
  externalReference: BOOKING_ID,
  amountCents: 150000,
  currency: "ARS",
  collectorId: "777",
  approvedAt: "2026-10-04T14:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  adminFailure = null;
  maybeSingle.mockResolvedValue({ data: { mp_user_id: "777" }, error: null });
  rpc.mockResolvedValue({ data: "applied", error: null });
  loadTenantAccessToken.mockResolvedValue(ok("TENANT-TOKEN"));
  searchPayments.mockResolvedValue(ok([payment]));
});

describe("applyMpPayment", () => {
  it("llama al RPC con el negocio, el turno (external_reference) y lo que dijo Mercado Pago", async () => {
    const result = await applyMpPayment("t-1", payment);

    expect(result).toEqual({ ok: true, value: "applied" });
    expect(rpc).toHaveBeenCalledWith("apply_booking_payment", {
      p_tenant_id: "t-1",
      p_booking_id: BOOKING_ID,
      p_mp_payment_id: "999",
      p_status: "approved",
      p_amount_cents: 150000,
      p_currency: "ARS",
      p_approved_at: "2026-10-04T14:00:00.000Z",
    });
  });

  it("sin date_approved manda null (la base lo toma como 'ahora')", async () => {
    await applyMpPayment("t-1", { ...payment, approvedAt: null });

    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_approved_at: null });
  });

  it("compara el collector con el mp_user_id del NEGOCIO que llegó en la URL", async () => {
    await applyMpPayment("t-1", payment);

    expect(from).toHaveBeenCalledWith("tenant_mp_accounts");
    expect(eq).toHaveBeenCalledWith("tenant_id", "t-1");
  });

  it("un collector distinto es 'ignored' y NO toca la base", async () => {
    const result = await applyMpPayment("t-1", { ...payment, collectorId: "123" });

    expect(result).toEqual({ ok: true, value: "ignored" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sin collector en el pago: falla cerrado ('ignored')", async () => {
    const result = await applyMpPayment("t-1", { ...payment, collectorId: null });

    expect(result).toEqual({ ok: true, value: "ignored" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un negocio sin cuenta conectada es 'ignored'", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await applyMpPayment("t-1", payment);

    expect(result).toEqual({ ok: true, value: "ignored" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([null, "no-es-un-uuid", "' or 1=1 --"])(
    "external_reference %j que no es un uuid es 'ignored'",
    async (externalReference) => {
      const result = await applyMpPayment("t-1", { ...payment, externalReference });

      expect(result).toEqual({ ok: true, value: "ignored" });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["applied", "duplicate", "ignored"] as const)("devuelve el resultado '%s' del RPC", async (outcome) => {
    rpc.mockResolvedValue({ data: outcome, error: null });

    const result = await applyMpPayment("t-1", payment);

    expect(result).toEqual({ ok: true, value: outcome });
  });

  it("un valor inesperado del RPC es un error (no se da por bueno)", async () => {
    rpc.mockResolvedValue({ data: "raro", error: null });

    const result = await applyMpPayment("t-1", payment);

    expect(result.ok === false && result.error.code).toBe("payment_apply_failed");
  });

  it("un error del RPC es payment_apply_failed (transitorio)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom con secretos" } });

    const result = await applyMpPayment("t-1", payment);

    expect(result.ok === false && result.error.code).toBe("payment_apply_failed");
    expect(JSON.stringify(result)).not.toContain("secretos");
  });

  it("un error leyendo la cuenta es account_load_failed y no llama al RPC", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await applyMpPayment("t-1", payment);

    expect(result.ok === false && result.error.code).toBe("account_load_failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("si createAdminClient tira (falta la service-role key) vuelve como Result, no como excepción", async () => {
    adminFailure = new Error("falta la key");

    const result = await applyMpPayment("t-1", payment);

    expect(result.ok === false && result.error.code).toBe("account_load_failed");
  });
});

describe("syncBookingPaymentFromReturn", () => {
  it("busca por external_reference con el token del negocio y aplica el pago más reciente", async () => {
    const older = { ...payment, id: "111", status: "rejected" };
    searchPayments.mockResolvedValue(ok([payment, older]));

    const result = await syncBookingPaymentFromReturn("t-1", BOOKING_ID);

    expect(result).toEqual({ ok: true, value: "applied" });
    expect(loadTenantAccessToken).toHaveBeenCalledWith("t-1");
    expect(searchPayments).toHaveBeenCalledWith("TENANT-TOKEN", BOOKING_ID, { timeoutMs: 3000 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_mp_payment_id: "999" });
  });

  it("el presupuesto de la búsqueda es configurable", async () => {
    await syncBookingPaymentFromReturn("t-1", BOOKING_ID, { timeoutMs: 1200 });

    expect(searchPayments).toHaveBeenCalledWith("TENANT-TOKEN", BOOKING_ID, { timeoutMs: 1200 });
  });

  it("sin pagos todavía: 'ignored' y no toca la base", async () => {
    searchPayments.mockResolvedValue(ok([]));

    const result = await syncBookingPaymentFromReturn("t-1", BOOKING_ID);

    expect(result).toEqual({ ok: true, value: "ignored" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un pago cuya referencia no es ESTE turno se ignora", async () => {
    searchPayments.mockResolvedValue(
      ok([{ ...payment, externalReference: "9a9a9a9a-4f89-41d3-9a0c-0305e82c3301" }]),
    );

    const result = await syncBookingPaymentFromReturn("t-1", BOOKING_ID);

    expect(result).toEqual({ ok: true, value: "ignored" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("un id de turno que no es uuid no sale a Mercado Pago", async () => {
    const result = await syncBookingPaymentFromReturn("t-1", "nope");

    expect(result).toEqual({ ok: true, value: "ignored" });
    expect(loadTenantAccessToken).not.toHaveBeenCalled();
  });

  it("propaga el error del token (cuenta no conectada, rota…)", async () => {
    loadTenantAccessToken.mockResolvedValue(err(appError("not_connected", "x")));

    const result = await syncBookingPaymentFromReturn("t-1", BOOKING_ID);

    expect(result.ok === false && result.error.code).toBe("not_connected");
    expect(searchPayments).not.toHaveBeenCalled();
  });

  it("propaga el error de la búsqueda", async () => {
    searchPayments.mockResolvedValue(err(appError("mp_unreachable", "x")));

    const result = await syncBookingPaymentFromReturn("t-1", BOOKING_ID);

    expect(result.ok === false && result.error.code).toBe("mp_unreachable");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propaga el error de aplicar", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });

    const result = await syncBookingPaymentFromReturn("t-1", BOOKING_ID);

    expect(result.ok === false && result.error.code).toBe("payment_apply_failed");
  });
});
