import { beforeEach, describe, expect, it, vi } from "vitest";

import { throwingRedirectSpy } from "@/test-support/next-navigation";

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

let tenant: { id: string } | null = null;
vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: async () => tenant,
}));

let owner: unknown = { ok: true, value: { tenantId: "t1" } };
vi.mock("./ownership", () => ({ currentOwnerTenant: async () => owner }));

const deleteTenantMpAccount = vi.fn();
vi.mock("./mp-accounts", () => ({
  deleteTenantMpAccount: (id: string) => deleteTenantMpAccount(id),
}));

let rpcResult: { error: { code?: string; message?: string } | null } = { error: null };
let sessionThrows = false;
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (sessionThrows) throw new Error("boom");
    return {
      rpc: async (fn: string, args: unknown) => {
        rpc(fn, args);
        return rpcResult;
      },
    };
  },
}));

const { toggleOnlinePaymentsAction, disconnectMpAction, markPaymentRefundedAction } =
  await import("./actions");

const form = (enabled?: string) => {
  const data = new FormData();
  if (enabled !== undefined) data.set("enabled", enabled);
  return data;
};

/** Corre la action y devuelve adónde redirigió (siempre termina en redirect). */
async function run(fn: () => Promise<void>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith("NEXT_REDIRECT:")) return message.slice("NEXT_REDIRECT:".length);
    throw e;
  }
  throw new Error("la action no redirigió");
}

beforeEach(() => {
  vi.clearAllMocks();
  tenant = { id: "t1" };
  owner = { ok: true, value: { tenantId: "t1" } };
  rpcResult = { error: null };
  sessionThrows = false;
  deleteTenantMpAccount.mockResolvedValue({ ok: true, value: undefined });
});

describe("toggleOnlinePaymentsAction", () => {
  it("prende: llama al RPC con la sesión y vuelve con la bandera", async () => {
    const to = await run(() => toggleOnlinePaymentsAction(form("true")));
    expect(rpc).toHaveBeenCalledWith("set_online_payments", { p_tenant_id: "t1", p_enabled: true });
    expect(to).toBe("/panel/pagos?mp=activado");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/pagos");
  });

  it("apaga", async () => {
    const to = await run(() => toggleOnlinePaymentsAction(form("false")));
    expect(rpc).toHaveBeenCalledWith("set_online_payments", { p_tenant_id: "t1", p_enabled: false });
    expect(to).toBe("/panel/pagos?mp=desactivado");
  });

  it.each([
    [{ code: "42501", message: "Solo el dueño" }, "sin-permiso"],
    [{ code: "P0001", message: "Los cobros online requieren el plan Pro o superior" }, "sin-plan"],
    [{ code: "P0001", message: "Mercado Pago no está conectado" }, "sin-conexion"],
    [{ code: "XX000", message: "algo interno" }, "fallo"],
  ])("traduce el error de la base %j a la bandera %s", async (error, flag) => {
    rpcResult = { error };
    const to = await run(() => toggleOnlinePaymentsAction(form("true")));
    expect(to).toBe(`/panel/pagos?mp=${flag}`);
  });

  it("un valor que no es true/false no toca nada", async () => {
    const to = await run(() => toggleOnlinePaymentsAction(form("quizás")));
    expect(rpc).not.toHaveBeenCalled();
    expect(to).toBe("/panel/pagos?mp=fallo");
  });

  it("sin negocio manda a ingresar", async () => {
    tenant = null;
    expect(await run(() => toggleOnlinePaymentsAction(form("true")))).toBe("/ingresar");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("si el cliente de sesión tira, vuelve con fallo", async () => {
    sessionThrows = true;
    expect(await run(() => toggleOnlinePaymentsAction(form("true")))).toBe("/panel/pagos?mp=fallo");
  });
});

describe("disconnectMpAction", () => {
  it("el dueño: apaga los pagos y borra la cuenta", async () => {
    const to = await run(() => disconnectMpAction());
    expect(rpc).toHaveBeenCalledWith("set_online_payments", { p_tenant_id: "t1", p_enabled: false });
    expect(deleteTenantMpAccount).toHaveBeenCalledWith("t1");
    expect(to).toBe("/panel/pagos?mp=desconectado");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/pagos");
  });

  it("un miembro que no es dueño no borra nada", async () => {
    owner = { ok: false, error: { code: "not_owner", message: "x" } };
    const to = await run(() => disconnectMpAction());
    expect(to).toBe("/panel/pagos?mp=sin-permiso");
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteTenantMpAccount).not.toHaveBeenCalled();
  });

  it("sin sesión manda a ingresar", async () => {
    owner = { ok: false, error: { code: "no_session", message: "x" } };
    expect(await run(() => disconnectMpAction())).toBe("/ingresar");
    expect(deleteTenantMpAccount).not.toHaveBeenCalled();
  });

  it("si no pudo apagar los pagos, NO borra la cuenta", async () => {
    rpcResult = { error: { code: "XX000", message: "boom" } };
    const to = await run(() => disconnectMpAction());
    expect(to).toBe("/panel/pagos?mp=fallo");
    expect(deleteTenantMpAccount).not.toHaveBeenCalled();
  });

  it("si el borrado falla, vuelve con fallo", async () => {
    deleteTenantMpAccount.mockResolvedValue({ ok: false, error: { code: "account_delete_failed", message: "x" } });
    expect(await run(() => disconnectMpAction())).toBe("/panel/pagos?mp=fallo");
  });
});

describe("markPaymentRefundedAction", () => {
  const refundForm = (id?: string) => {
    const data = new FormData();
    if (id !== undefined) data.set("id", id);
    return data;
  };

  it("llama al RPC con la sesión y vuelve con la bandera de éxito", async () => {
    const to = await run(() => markPaymentRefundedAction(refundForm("p1")));
    expect(rpc).toHaveBeenCalledWith("mark_payment_refunded", { p_booking_payment_id: "p1" });
    expect(to).toBe("/panel/pagos?mp=devuelto");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/pagos");
    expect(revalidatePath).toHaveBeenCalledWith("/panel");
  });

  it.each([
    [{ code: "42501", message: "x" }, "devolucion-sin-permiso"],
    [{ code: "P0001", message: "Ese pago no está pendiente de devolución" }, "devolucion-no-pendiente"],
    [{ code: "XX000", message: "boom" }, "fallo"],
  ])("traduce el error %j a la bandera %s", async (error, flag) => {
    rpcResult = { error };
    const to = await run(() => markPaymentRefundedAction(refundForm("p1")));
    expect(to).toBe(`/panel/pagos?mp=${flag}`);
  });

  it("sin id no toca la base", async () => {
    const to = await run(() => markPaymentRefundedAction(refundForm("  ")));
    expect(rpc).not.toHaveBeenCalled();
    expect(to).toBe("/panel/pagos?mp=fallo");
  });

  it("sin negocio manda a ingresar", async () => {
    tenant = null;
    const to = await run(() => markPaymentRefundedAction(refundForm("p1")));
    expect(rpc).not.toHaveBeenCalled();
    expect(to).toBe("/ingresar");
  });

  it("si el cliente de sesión tira, vuelve con fallo", async () => {
    sessionThrows = true;
    const to = await run(() => markPaymentRefundedAction(refundForm("p1")));
    expect(to).toBe("/panel/pagos?mp=fallo");
  });
});
