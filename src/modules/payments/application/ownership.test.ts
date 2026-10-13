import { beforeEach, describe, expect, it, vi } from "vitest";

let tenant: { id: string } | null = null;
vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: async () => tenant,
}));

let user: { id: string } | null = null;
let membership: { data: unknown; error: unknown } = { data: null, error: null };
let sessionThrows = false;
const eq = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (sessionThrows) throw new Error("boom");
    const chain = {
      select: () => chain,
      eq: (col: string, val: string) => {
        eq(col, val);
        return chain;
      },
      maybeSingle: async () => membership,
    };
    return {
      auth: { getUser: async () => ({ data: { user } }) },
      from: () => chain,
    };
  },
}));

const { currentOwnerTenant, canMarkRefunds } = await import("./ownership");

beforeEach(() => {
  vi.clearAllMocks();
  tenant = { id: "t1" };
  user = { id: "u1" };
  membership = { data: { role: "owner" }, error: null };
  sessionThrows = false;
});

describe("currentOwnerTenant", () => {
  it("devuelve el negocio cuando el usuario es su dueño", async () => {
    const result = await currentOwnerTenant();
    expect(result).toEqual({ ok: true, value: { tenantId: "t1" } });
    // La pregunta se hace por usuario, negocio Y rol.
    expect(eq).toHaveBeenCalledWith("user_id", "u1");
    expect(eq).toHaveBeenCalledWith("tenant_id", "t1");
    expect(eq).toHaveBeenCalledWith("role", "owner");
  });

  it("sin sesión o sin negocio: no_session", async () => {
    tenant = null;
    const result = await currentOwnerTenant();
    expect(!result.ok && result.error.code).toBe("no_session");
  });

  it("un miembro que no es dueño: not_owner", async () => {
    membership = { data: null, error: null };
    const result = await currentOwnerTenant();
    expect(!result.ok && result.error.code).toBe("not_owner");
  });

  it("si la consulta falla o tira, no es dueño (falla cerrado)", async () => {
    membership = { data: null, error: { message: "x" } };
    expect((await currentOwnerTenant()).ok).toBe(false);
    sessionThrows = true;
    const result = await currentOwnerTenant();
    expect(result.ok).toBe(false);
  });
});

describe("canMarkRefunds", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["staff", false],
  ])("el rol %s => %s", async (role, expected) => {
    membership = { data: { role }, error: null };
    expect(await canMarkRefunds("t1")).toBe(expected);
    // Por usuario y negocio: el rol se decide en código, no se confía en un filtro.
    expect(eq).toHaveBeenCalledWith("user_id", "u1");
    expect(eq).toHaveBeenCalledWith("tenant_id", "t1");
  });

  it("sin membresía, sin sesión o con la consulta rota: no (falla cerrado)", async () => {
    membership = { data: null, error: null };
    expect(await canMarkRefunds("t1")).toBe(false);
    membership = { data: { role: "owner" }, error: { message: "x" } };
    expect(await canMarkRefunds("t1")).toBe(false);
    membership = { data: { role: "owner" }, error: null };
    user = null;
    expect(await canMarkRefunds("t1")).toBe(false);
    user = { id: "u1" };
    sessionThrows = true;
    expect(await canMarkRefunds("t1")).toBe(false);
  });
});
