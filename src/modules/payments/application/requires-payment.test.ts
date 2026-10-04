import { beforeEach, describe, expect, it, vi } from "vitest";

import { tenantRequiresPayment } from "./requires-payment";

const rpc = vi.fn<(fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>();
let adminFailure: Error | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return { rpc: (fn: string, args: unknown) => rpc(fn, args) };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  adminFailure = null;
});

describe("tenantRequiresPayment", () => {
  it("pregunta a tenant_requires_payment y devuelve true cuando la base dice true", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(tenantRequiresPayment("t-1")).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("tenant_requires_payment", { p_tenant_id: "t-1" });
  });

  it("devuelve false cuando la base dice false", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(tenantRequiresPayment("t-1")).resolves.toBe(false);
  });

  it.each([
    ["un error de la RPC", { data: null, error: { message: "boom" } }],
    ["una respuesta que no es booleana", { data: "true", error: null }],
    ["data nula", { data: null, error: null }],
  ])("falla SEGURO a false ante %s", async (_label, value) => {
    rpc.mockResolvedValue(value);
    await expect(tenantRequiresPayment("t-1")).resolves.toBe(false);
  });

  it("falla seguro a false si la RPC tira o falta la service-role key", async () => {
    rpc.mockRejectedValue(new Error("red"));
    await expect(tenantRequiresPayment("t-1")).resolves.toBe(false);

    adminFailure = new Error("falta la key");
    await expect(tenantRequiresPayment("t-1")).resolves.toBe(false);
  });
});
