import { beforeEach, describe, expect, it, vi } from "vitest";

let rpcResult: { data: unknown; error: unknown } = { data: 0, error: null };
let adminFailure: Error | null = null;
const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return {
      rpc: (fn: string, args: unknown) => {
        rpc(fn, args);
        return Promise.resolve(rpcResult);
      },
    };
  },
}));

const { cancelExpiredPaymentHolds } = await import("./cancel-expired-holds");

beforeEach(() => {
  vi.clearAllMocks();
  rpcResult = { data: 0, error: null };
  adminFailure = null;
});

describe("cancelExpiredPaymentHolds", () => {
  it("calls the service-role RPC and returns how many holds it cancelled", async () => {
    rpcResult = { data: 4, error: null };

    const result = await cancelExpiredPaymentHolds();

    expect(rpc).toHaveBeenCalledWith("cancel_expired_payment_holds", undefined);
    expect(result).toEqual({ ok: true, value: 4 });
  });

  it("an RPC error is an error Result", async () => {
    rpcResult = { data: null, error: { message: "boom" } };

    const result = await cancelExpiredPaymentHolds();

    expect(!result.ok && result.error.code).toBe("hold_cleanup_failed");
  });

  it("a non numeric answer is an error, not zero", async () => {
    rpcResult = { data: null, error: null };

    const result = await cancelExpiredPaymentHolds();

    expect(result.ok).toBe(false);
  });

  it("a missing service-role key does not escape as an exception", async () => {
    adminFailure = new Error("sin service role");

    const result = await cancelExpiredPaymentHolds();

    expect(result.ok).toBe(false);
  });
});
