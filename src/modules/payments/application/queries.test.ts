import { beforeEach, describe, expect, it, vi } from "vitest";

let tenantRow: { data: unknown; error: unknown } = { data: null, error: null };
let accountRow: { data: unknown; error: unknown } = { data: null, error: null };
let adminThrows = false;
const selected = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminThrows) throw new Error("sin service role");
    return {
      from: (table: string) => {
        const chain = {
          select: (cols: string) => {
            selected(table, cols);
            return chain;
          },
          eq: () => chain,
          maybeSingle: async () => (table === "tenants" ? tenantRow : accountRow),
        };
        return chain;
      },
    };
  },
}));

const { getPaymentsState } = await import("./queries");

beforeEach(() => {
  vi.clearAllMocks();
  tenantRow = { data: { online_payments_enabled: false }, error: null };
  accountRow = { data: null, error: null };
  adminThrows = false;
});

describe("getPaymentsState", () => {
  it("sin cuenta: apagado y sin conexión", async () => {
    const result = await getPaymentsState("t1");
    expect(result).toEqual({ ok: true, value: { enabled: false, account: null } });
  });

  it("con cuenta conectada y prendido", async () => {
    tenantRow = { data: { online_payments_enabled: true }, error: null };
    accountRow = {
      data: { status: "connected", connected_at: "2026-10-01T10:00:00Z" },
      error: null,
    };
    const result = await getPaymentsState("t1");
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        account: { status: "connected", connectedAt: "2026-10-01T10:00:00Z" },
      },
    });
  });

  it("nunca pide las columnas cifradas", async () => {
    await getPaymentsState("t1");
    for (const [, cols] of selected.mock.calls as [string, string][]) {
      expect(cols).not.toMatch(/ciphertext|token/);
    }
  });

  it("un estado desconocido se lee como roto, no como conectado", async () => {
    accountRow = { data: { status: "algo-raro", connected_at: "2026-10-01T10:00:00Z" }, error: null };
    const result = await getPaymentsState("t1");
    expect(result.ok && result.value.account?.status).toBe("broken");
  });

  it("falla de lectura o del cliente: error, no un estado inventado", async () => {
    accountRow = { data: null, error: { message: "x" } };
    expect((await getPaymentsState("t1")).ok).toBe(false);
    adminThrows = true;
    expect((await getPaymentsState("t1")).ok).toBe(false);
  });
});
