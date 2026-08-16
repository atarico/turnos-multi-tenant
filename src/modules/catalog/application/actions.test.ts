import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import {
  deleteServiceAction,
  saveServiceAction,
  toggleServiceActiveAction,
} from "./actions";

/**
 * Tests de las escrituras del catálogo: alta, edición, pausa y baja.
 *
 * La obsesión de la edición y la pausa es una sola: que la pantalla NO diga
 * "guardado" sobre algo que no se guardó. PostgREST devuelve `error: null` con
 * cero filas cuando RLS recorta un UPDATE, o cuando el `id` que mandó el
 * formulario ya no existe — dos pestañas abiertas, borrás el servicio en una y
 * lo editás en la otra.
 *
 * La baja es otra historia y por eso vive en su propio `describe`: delega en la
 * RPC `delete_service` (SECURITY INVOKER, migración `20260811120001`), que
 * decide en la base si hay turnos que la bloquean. La action llama a la RPC UNA
 * vez y traduce el `delete_outcome` devuelto a la copy que ve el usuario.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

/**
 * Builder encadenable. El UPDATE resuelve con la LISTA de filas afectadas
 * (`rowsResult`), que es lo único que distingue un guardado real de uno
 * recortado a cero; el INSERT resuelve sólo con error, porque un insert
 * bloqueado por RLS sí falla de frente.
 */
let rowsResult: { data: Array<{ id: string }> | null; error: unknown } = {
  data: [{ id: "srv-1" }],
  error: null,
};
let insertError: { message: string } | null = null;

const update = vi.fn();
const insert = vi.fn();
const select = vi.fn();
const eq = vi.fn();

function chain(resolveWith: () => unknown) {
  const builder: Record<string, unknown> = {};
  builder.eq = (...args: unknown[]) => {
    eq(...args);
    return builder;
  };
  builder.select = (...args: unknown[]) => {
    select(...args);
    return builder;
  };
  builder.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve(resolve(resolveWith()));
  return builder;
}

const from = vi.fn(() => ({
  update: (values: unknown) => {
    update(values);
    return chain(() => rowsResult);
  },
  insert: (values: unknown) => {
    insert(values);
    return chain(() => ({ data: null, error: insertError }));
  },
}));

/**
 * La RPC de la baja. El tipo se declara ancho a propósito: los tests de
 * `deleteServiceAction` la resuelven con cada `delete_outcome` posible y también
 * con error, incluida la carrera `23503` contra la foreign key.
 */
const rpc = vi.fn(async () => ({
  data: "deleted" as string | null,
  error: null as { code?: string; message: string } | null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from, rpc }),
}));

const getCurrentTenant = vi.fn(async (): Promise<unknown> => ({
  id: "tenant-1",
  slug: "negocio",
}));
vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: () => getCurrentTenant(),
}));

function serviceForm(id = ""): FormData {
  const form = new FormData();
  form.append("id", id);
  form.append("name", "Corte de pelo");
  form.append("description", "");
  form.append("durationMin", "45");
  form.append("price", "1500");
  form.append("capacity", "1");
  return form;
}

function toggleForm(id = "srv-1", active = "false"): FormData {
  const form = new FormData();
  form.append("id", id);
  form.append("active", active);
  return form;
}

function deleteForm(id = "service-1"): FormData {
  const form = new FormData();
  form.append("id", id);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  rowsResult = { data: [{ id: "srv-1" }], error: null };
  insertError = null;
  rpc.mockResolvedValue({ data: "deleted", error: null });
  getCurrentTenant.mockResolvedValue({ id: "tenant-1", slug: "negocio" });
});

describe("saveServiceAction", () => {
  it("edita un servicio existente", async () => {
    const result = await saveServiceAction(idleState, serviceForm("srv-1"));

    expect(result.status).toBe("success");
    expect(update).toHaveBeenCalled();
  });

  // La edición filtra por id Y por tenant: la RLS acompaña, no reemplaza.
  it("filtra la edición por id y por negocio", async () => {
    await saveServiceAction(idleState, serviceForm("srv-1"));

    expect(eq).toHaveBeenCalledWith("id", "srv-1");
    expect(eq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("pide la fila de vuelta para poder contar lo que escribió", async () => {
    await saveServiceAction(idleState, serviceForm("srv-1"));

    expect(select).toHaveBeenCalled();
  });

  /**
   * EL caso. Sin contar filas, esto respondía "Servicio actualizado." sobre una
   * escritura que no ocurrió.
   */
  it("no dice que guardó si no se tocó ninguna fila", async () => {
    rowsResult = { data: [], error: null };

    const result = await saveServiceAction(idleState, serviceForm("srv-1"));

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("tampoco dice que guardó si la base devolvió error", async () => {
    rowsResult = { data: null, error: { message: "boom" } };

    const result = await saveServiceAction(idleState, serviceForm("srv-1"));

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("crea un servicio cuando no viene id", async () => {
    const result = await saveServiceAction(idleState, serviceForm());

    expect(result.status).toBe("success");
    expect(insert).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * El alta NO necesita contar filas: un INSERT bloqueado por RLS devuelve
   * error de verdad. Se prueba que sigue reaccionando al error, para que nadie
   * "unifique" los dos caminos y le agregue un guard que ahí no aplica.
   */
  it("informa el error del alta sin contar filas", async () => {
    insertError = { message: "boom" };

    const result = await saveServiceAction(idleState, serviceForm());

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rechaza datos inválidos sin tocar la base", async () => {
    const form = serviceForm();
    form.set("durationMin", "0");

    const result = await saveServiceAction(idleState, form);

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });
});

describe("toggleServiceActiveAction", () => {
  it("pausa un servicio", async () => {
    const result = await toggleServiceActiveAction(idleState, toggleForm());

    expect(result.status).toBe("success");
    expect(update).toHaveBeenCalledWith({ active: false });
  });

  it("no dice que lo pausó si no se tocó ninguna fila", async () => {
    rowsResult = { data: [], error: null };

    const result = await toggleServiceActiveAction(idleState, toggleForm());

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("frena sin id, sin tocar la base", async () => {
    const result = await toggleServiceActiveAction(idleState, toggleForm(""));

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });
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
