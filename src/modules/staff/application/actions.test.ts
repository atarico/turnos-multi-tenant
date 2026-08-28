import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import { appError, err, ok } from "@/core/result";

import {
  deleteStaffAction,
  saveScheduleAction,
  saveStaffAction,
  toggleStaffActiveAction,
} from "./actions";

/**
 * Tests de `saveScheduleAction`: el guardado del horario semanal tiene que ser
 * ATÓMICO. La action delega en la función de base `replace_staff_schedule`
 * (SECURITY DEFINER) vía RPC: una sola transacción borra e inserta la semana,
 * así un fallo a mitad de camino no deja al profesional sin horario.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

const rpc = vi.fn(async () => ({
  data: null as string | null,
  error: null as { code?: string; message: string } | null,
}));

/** Lo que devuelve cualquier consulta del builder falso de Supabase. */
type QueryResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

/**
 * Builder encadenable mínimo: cada método devuelve el mismo objeto, que además
 * es awaitable. Alcanza para `insert().select().single()`, `update().eq().eq()`
 * y `delete().eq().not()`, que es todo lo que hace `saveStaffAction`.
 */
interface QueryChain extends PromiseLike<QueryResult> {
  insert(): QueryChain;
  update(): QueryChain;
  delete(): QueryChain;
  select(...args: unknown[]): QueryChain;
  eq(): QueryChain;
  not(): QueryChain;
  single(): Promise<QueryResult>;
}

/**
 * Espía del `.select()`. Sin él, un UPDATE que perdiera el `.select("id")`
 * dejaría `data` en `null`, `wroteRows` devolvería `false` y toda pausa exitosa
 * se volvería un error visible para el usuario — sin que ningún test cayera.
 */
const select = vi.fn();

const NEW_STAFF_ID = "staff-nuevo";

/**
 * Dos formas de resultado, porque la base devuelve dos cosas distintas.
 *
 * `.single()` —el alta— devuelve UNA fila como objeto. Un `.select()` sobre un
 * UPDATE devuelve la LISTA de filas afectadas, y esa lista es lo único que
 * distingue un guardado real de uno que RLS recortó a cero sin dar error.
 * Mezclarlas en un solo doble haría que el guard de filas afectadas nunca
 * pudiera probarse.
 */
let queryResult: QueryResult = { data: { id: NEW_STAFF_ID }, error: null };
let rowsResult: { data: Array<{ id: string }> | null; error: unknown } = {
  data: [{ id: "staff-1" }],
  error: null,
};

const chain: QueryChain = {
  insert: () => chain,
  update: () => chain,
  delete: () => chain,
  select: (...args: unknown[]) => {
    select(...args);
    return chain;
  },
  eq: () => chain,
  not: () => chain,
  single: async () => queryResult,
  then: (onfulfilled, onrejected) =>
    Promise.resolve(rowsResult as QueryResult).then(onfulfilled, onrejected),
};

const from = vi.fn(() => chain);
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc, from }),
}));

// El plan viaja en el negocio, así que el cupo se resuelve sin una consulta más.
const getCurrentTenant = vi.fn(async (): Promise<unknown> => ({
  id: "tenant-1",
  slug: "negocio",
  plan: "basico",
}));
vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: () => getCurrentTenant(),
}));

const getStaffMember = vi.fn(async (): Promise<unknown> =>
  ok({ id: "staff-1", name: "Ana", role: null, active: true, serviceIds: [] }),
);
const countActiveStaff = vi.fn<
  (tenantId: string, excludeStaffId?: string) => Promise<unknown>
>(async () => ok(0));
vi.mock("./queries", () => ({
  getStaffMember: () => getStaffMember(),
  countActiveStaff: (tenantId: string, excludeStaffId?: string) =>
    countActiveStaff(tenantId, excludeStaffId),
}));

/** Arma el FormData tal como lo manda el editor de horarios. */
function scheduleForm(
  windows: { weekday: string; start: string; end: string }[],
  staffId = "staff-1",
): FormData {
  const form = new FormData();
  form.append("staffId", staffId);
  for (const w of windows) {
    form.append("weekday", w.weekday);
    form.append("startTime", w.start);
    form.append("endTime", w.end);
  }
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: "deleted", error: null });
  queryResult = { data: { id: NEW_STAFF_ID }, error: null };
  rowsResult = { data: [{ id: "staff-1" }], error: null };
  // `clearAllMocks` limpia llamadas, NO implementaciones: sin este reset, un
  // `mockResolvedValue` puesto en un test se filtra a todos los siguientes.
  countActiveStaff.mockResolvedValue(ok(0));
  getCurrentTenant.mockResolvedValue({
    id: "tenant-1",
    slug: "negocio",
    plan: "basico",
  });
});

/** Arma el FormData tal como lo manda el formulario de profesionales. */
function staffForm(id = ""): FormData {
  const form = new FormData();
  form.append("id", id);
  form.append("name", "Ana Gómez");
  form.append("role", "Peluquera");
  return form;
}

/**
 * Un profesional sin horario no ofrece un solo turno, así que el alta encadena
 * con la pantalla de horarios. La edición NO: quien corrige un nombre no quiere
 * que lo saquen de la pantalla en la que está.
 */
describe("saveStaffAction", () => {
  it("después de un ALTA manda al horario del profesional recién creado", async () => {
    await saveStaffAction(idleState, staffForm());

    expect(redirect).toHaveBeenCalledWith(
      `/panel/profesionales/${NEW_STAFF_ID}/horarios`,
    );
  });

  it("después de una EDICIÓN no mueve al usuario de pantalla", async () => {
    const result = await saveStaffAction(idleState, staffForm("staff-1"));

    expect(result.status).toBe("success");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("si el alta falla no encadena con los horarios", async () => {
    queryResult = { data: null, error: { message: "boom" } };

    const result = await saveStaffAction(idleState, staffForm());

    expect(result.status).toBe("error");
    expect(redirect).not.toHaveBeenCalled();
  });

  /**
   * El fallo silencioso: PostgREST devuelve `error: null` con cero filas cuando
   * RLS recorta el UPDATE, o cuando el `id` ya no existe. Sin contar las filas,
   * editar un profesional borrado en otra pestaña respondía "guardado" sobre
   * una fila que no está.
   */
  it("no dice que guardó la edición si no se tocó ninguna fila", async () => {
    rowsResult = { data: [], error: null };

    const result = await saveStaffAction(idleState, staffForm("staff-1"));

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * El cupo de profesionales es el límite de STOCK del plan, y sólo se chequea
   * en el ALTA. Básico llega a 2 activos.
   */
  it("no da de alta si el plan ya está lleno", async () => {
    countActiveStaff.mockResolvedValue(ok(2));

    const result = await saveStaffAction(idleState, staffForm());

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  // En el alta no hay a quién excluir del conteo: el profesional todavía no existe.
  it("cuenta el cupo contra el negocio actual, sin excluir a nadie", async () => {
    await saveStaffAction(idleState, staffForm());

    expect(countActiveStaff).toHaveBeenCalledWith("tenant-1", undefined);
  });

  it("un plan más grande deja pasar el mismo alta", async () => {
    getCurrentTenant.mockResolvedValue({
      id: "tenant-1",
      slug: "negocio",
      plan: "pro",
    });
    countActiveStaff.mockResolvedValue(ok(2));

    const result = await saveStaffAction(idleState, staffForm());

    expect(result.status).not.toBe("error");
  });

  /**
   * LO QUE NO SE PUEDE ROMPER: un negocio que bajó de plan queda POR ENCIMA del
   * cupo, y aun así tiene que poder editar lo que ya tiene. Si el guard se
   * colara en la edición, alguien con 9 profesionales en Básico no podría ni
   * corregir un nombre mal escrito.
   */
  it("deja editar aunque el negocio esté por encima del cupo", async () => {
    countActiveStaff.mockResolvedValue(ok(9));

    const result = await saveStaffAction(idleState, staffForm("staff-1"));

    expect(result.status).toBe("success");
  });

  /**
   * Si no se pudo contar, no se da de alta a ciegas: dejar pasar el alta ante
   * la duda convierte el cupo en una sugerencia.
   */
  it("no da de alta a ciegas si no se pudo verificar el cupo", async () => {
    countActiveStaff.mockResolvedValue(
      err(appError("staff_query_failed", "boom")),
    );

    const result = await saveStaffAction(idleState, staffForm());

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });
});

/** Arma el FormData del botón de activar/pausar. */
function toggleForm(id = "staff-1", active = "false"): FormData {
  const form = new FormData();
  form.append("id", id);
  form.append("active", active);
  return form;
}

describe("toggleStaffActiveAction", () => {
  it("pausa un profesional", async () => {
    const result = await toggleStaffActiveAction(idleState, toggleForm());

    expect(result.status).toBe("success");
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("pide la fila de vuelta para poder contar lo que escribió", async () => {
    await toggleStaffActiveAction(idleState, toggleForm());

    expect(select).toHaveBeenCalledWith("id");
  });

  /**
   * El fallo silencioso: PostgREST devuelve `error: null` con cero filas cuando
   * RLS recorta el UPDATE, o cuando el `id` ya no existe. Sin contar las filas,
   * pausar un profesional borrado en otra pestaña respondía "Profesional
   * pausado." sobre una fila que no está.
   */
  it("no dice que lo pausó si no se tocó ninguna fila", async () => {
    rowsResult = { data: [], error: null };

    const result = await toggleStaffActiveAction(idleState, toggleForm());

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("frena sin id, sin tocar la base", async () => {
    const result = await toggleStaffActiveAction(idleState, toggleForm(""));

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });

  /**
   * EL AGUJERO QUE CIERRA ESTE GUARD. Como el cupo cuenta sólo activos, pausar
   * libera un lugar — y sin chequear la reactivación se podía dar la vuelta
   * completa: pausar a uno, crear otro, y reactivar al pausado. Tres clics para
   * terminar por encima del límite del plan.
   */
  it("no reactiva si el plan ya está lleno con los otros", async () => {
    countActiveStaff.mockResolvedValue(ok(2));

    const result = await toggleStaffActiveAction(
      idleState,
      toggleForm("staff-1", "true"),
    );

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });

  /**
   * El conteo excluye al profesional que se está tocando. Sin la exclusión,
   * reactivar a alguien que YA estaba activo se contaría a sí mismo y daría
   * "límite alcanzado" sobre una operación que no cambia nada.
   */
  it("al reactivar no se cuenta a sí mismo", async () => {
    await toggleStaffActiveAction(idleState, toggleForm("staff-1", "true"));

    expect(countActiveStaff).toHaveBeenCalledWith("tenant-1", "staff-1");
  });

  /**
   * Pausar NUNCA se bloquea: siempre baja la cuenta. Y es justo la salida del
   * negocio que quedó por encima del cupo — trabarla lo dejaría encerrado.
   */
  it("pausar no consulta el cupo ni se bloquea nunca", async () => {
    countActiveStaff.mockResolvedValue(ok(99));

    const result = await toggleStaffActiveAction(idleState, toggleForm());

    expect(result.status).toBe("success");
    expect(countActiveStaff).not.toHaveBeenCalled();
  });

  it("no reactiva a ciegas si no se pudo verificar el cupo", async () => {
    countActiveStaff.mockResolvedValue(
      err(appError("staff_count_failed", "boom")),
    );

    const result = await toggleStaffActiveAction(
      idleState,
      toggleForm("staff-1", "true"),
    );

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });
});

describe("saveScheduleAction", () => {
  it("reemplaza la semana con UNA llamada atómica a replace_staff_schedule", async () => {
    const result = await saveScheduleAction(
      idleState,
      scheduleForm([
        { weekday: "1", start: "09:00", end: "13:00" },
        { weekday: "3", start: "14:00", end: "18:00" },
      ]),
    );

    expect(result.status).toBe("success");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("replace_staff_schedule", {
      p_staff_id: "staff-1",
      p_windows: [
        { weekday: 1, start_time: "09:00", end_time: "13:00" },
        { weekday: 3, start_time: "14:00", end_time: "18:00" },
      ],
    });
  });

  it("manda una semana vacía como lista vacía (borrar todo el horario)", async () => {
    const result = await saveScheduleAction(idleState, scheduleForm([]));

    expect(result.status).toBe("success");
    expect(rpc).toHaveBeenCalledWith("replace_staff_schedule", {
      p_staff_id: "staff-1",
      p_windows: [],
    });
  });

  it("si la RPC falla devuelve error y NO revalida nada", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await saveScheduleAction(
      idleState,
      scheduleForm([{ weekday: "1", start: "09:00", end: "13:00" }]),
    );

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // Guardar el horario es el último paso de la puesta a punto: terminarlo
  // devuelve al listado, que es desde donde se sigue trabajando.
  it("después de guardar vuelve al listado de profesionales", async () => {
    await saveScheduleAction(
      idleState,
      scheduleForm([{ weekday: "1", start: "09:00", end: "13:00" }]),
    );

    expect(redirect).toHaveBeenCalledWith("/panel/profesionales");
  });

  it("si la RPC falla no vuelve al listado", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    await saveScheduleAction(
      idleState,
      scheduleForm([{ weekday: "1", start: "09:00", end: "13:00" }]),
    );

    expect(redirect).not.toHaveBeenCalled();
  });

  it("frena en el dominio (solape) sin tocar la base", async () => {
    const result = await saveScheduleAction(
      idleState,
      scheduleForm([
        { weekday: "1", start: "09:00", end: "13:00" },
        { weekday: "1", start: "12:00", end: "15:00" },
      ]),
    );

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("frena si el profesional no es del negocio, sin tocar la base", async () => {
    getStaffMember.mockResolvedValue(
      err(appError("staff_not_found", "Ese profesional no existe.")),
    );

    const result = await saveScheduleAction(
      idleState,
      scheduleForm([{ weekday: "1", start: "09:00", end: "13:00" }]),
    );

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });
});

/**
 * Tests de `deleteStaffAction`: la baja de un profesional delega en la RPC
 * `delete_staff` (SECURITY INVOKER, migración `20260811120001`), que decide
 * en la base si hay turnos que la bloquean. La action sólo llama a la RPC UNA
 * vez y traduce el `delete_outcome` devuelto a la copy que ve el usuario — ya
 * NO cuenta turnos desde la aplicación (ese conteo era redundante y, peor,
 * racy contra la RPC).
 */
function deleteForm(id = "staff-1"): FormData {
  const form = new FormData();
  form.append("id", id);
  return form;
}

describe("deleteStaffAction", () => {
  it("llama UNA vez a delete_staff con el tenant y el profesional", async () => {
    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result.status).toBe("success");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("delete_staff", {
      p_tenant_id: "tenant-1",
      p_staff_id: "staff-1",
    });
  });

  it("outcome 'deleted' revalida panel, profesionales y la página pública", async () => {
    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result.status).toBe("success");
    expect(revalidatePath).toHaveBeenCalledTimes(3);
    expect(revalidatePath).toHaveBeenCalledWith("/panel");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/profesionales");
    expect(revalidatePath).toHaveBeenCalledWith("/negocio");
  });

  it("outcome 'blocked_upcoming' devuelve la copy de turnos agendados y no revalida", async () => {
    rpc.mockResolvedValue({ data: "blocked_upcoming", error: null });

    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result).toEqual({
      status: "error",
      message:
        "Este profesional tiene turnos agendados. Cancelalos o esperá a que pasen para poder eliminarlo.",
      fieldErrors: undefined,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("outcome 'blocked_history' devuelve la copy de historial y no revalida", async () => {
    rpc.mockResolvedValue({ data: "blocked_history", error: null });

    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result).toEqual({
      status: "error",
      message:
        "Este profesional tiene turnos completados en tu historial, así que no se puede eliminar. Pausalo para dejar de ofrecerlo.",
      fieldErrors: undefined,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("si la RPC falla devuelve el mensaje genérico y no revalida", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result.status).toBe("error");
    expect(result).toMatchObject({
      message: "No pudimos eliminar al profesional. Intentá de nuevo.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("si la RPC devuelve 23503 (carrera con la FK) muestra la copy de turnos y no revalida", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "23503", message: "foreign key violation" },
    });

    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result).toEqual({
      status: "error",
      message:
        "Este profesional ya tiene turnos, así que no se puede eliminar sin perderlos. Pausalo para dejar de ofrecerlo.",
      fieldErrors: undefined,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sin id no llama a la RPC", async () => {
    const result = await deleteStaffAction(idleState, deleteForm(""));

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sin negocio actual no llama a la RPC", async () => {
    getCurrentTenant.mockResolvedValue(null);

    const result = await deleteStaffAction(idleState, deleteForm());

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
