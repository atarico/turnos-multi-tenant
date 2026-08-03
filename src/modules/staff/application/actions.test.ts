import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import { appError, err, ok } from "@/core/result";

import { saveScheduleAction } from "./actions";

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

const rpc = vi.fn(async () => ({ error: null as { message: string } | null }));
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

const getStaffMember = vi.fn(async (): Promise<unknown> =>
  ok({ id: "staff-1", name: "Ana", role: null, active: true, serviceIds: [] }),
);
vi.mock("./queries", () => ({
  getStaffMember: () => getStaffMember(),
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
  rpc.mockResolvedValue({ error: null });
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
    rpc.mockResolvedValue({ error: { message: "boom" } });

    const result = await saveScheduleAction(
      idleState,
      scheduleForm([{ weekday: "1", start: "09:00", end: "13:00" }]),
    );

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
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
