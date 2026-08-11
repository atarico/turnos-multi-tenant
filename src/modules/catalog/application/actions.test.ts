import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import { deleteServiceAction } from "./actions";

/**
 * Tests de `deleteServiceAction`: la baja de un servicio delega en la RPC
 * `delete_service` (SECURITY INVOKER, migración `20260811120001`), que decide
 * en la base si hay turnos que la bloquean. La action sólo llama a la RPC UNA
 * vez y traduce el `delete_outcome` devuelto a la copy que ve el usuario.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

const rpc = vi.fn(async () => ({
  data: "deleted" as string | null,
  error: null as { code?: string; message: string } | null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));

const getCurrentTenant = vi.fn(async (): Promise<unknown> => ({
  id: "tenant-1",
  slug: "negocio",
}));
vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: () => getCurrentTenant(),
}));

function deleteForm(id = "service-1"): FormData {
  const form = new FormData();
  form.append("id", id);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: "deleted", error: null });
});

describe("deleteServiceAction", () => {
  it("llama UNA vez a delete_service con el tenant y el servicio", async () => {
    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result.status).toBe("success");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("delete_service", {
      p_tenant_id: "tenant-1",
      p_service_id: "service-1",
    });
  });

  it("outcome 'deleted' revalida panel, catálogo y la página pública", async () => {
    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result.status).toBe("success");
    expect(revalidatePath).toHaveBeenCalledTimes(3);
    expect(revalidatePath).toHaveBeenCalledWith("/panel");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/servicios");
    expect(revalidatePath).toHaveBeenCalledWith("/negocio");
  });

  it("outcome 'blocked_upcoming' devuelve la copy de turnos agendados y no revalida", async () => {
    rpc.mockResolvedValue({ data: "blocked_upcoming", error: null });

    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result).toEqual({
      status: "error",
      message:
        "Este servicio tiene turnos agendados. Cancelalos o esperá a que pasen para poder eliminarlo.",
      fieldErrors: undefined,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("outcome 'blocked_history' devuelve la copy de historial y no revalida", async () => {
    rpc.mockResolvedValue({ data: "blocked_history", error: null });

    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result).toEqual({
      status: "error",
      message:
        "Este servicio tiene turnos completados en tu historial, así que no se puede eliminar. Pausalo para dejar de ofrecerlo.",
      fieldErrors: undefined,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("si la RPC falla devuelve el mensaje genérico y no revalida", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result.status).toBe("error");
    expect(result).toMatchObject({
      message: "No pudimos eliminar el servicio. Intentá de nuevo.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("si la RPC devuelve 23503 (carrera con la FK) muestra la copy de turnos y no revalida", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "23503", message: "foreign key violation" },
    });

    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result).toEqual({
      status: "error",
      message:
        "Este servicio ya tiene turnos, así que no se puede eliminar. Pausalo para dejar de ofrecerlo.",
      fieldErrors: undefined,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sin id no llama a la RPC", async () => {
    const result = await deleteServiceAction(idleState, deleteForm(""));

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sin negocio actual no llama a la RPC", async () => {
    getCurrentTenant.mockResolvedValue(null);

    const result = await deleteServiceAction(idleState, deleteForm());

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
