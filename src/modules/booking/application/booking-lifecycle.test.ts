import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import { appError, err, ok } from "@/core/result";

import {
  rescheduleBookingAction,
  updateBookingStatusAction,
} from "./booking-lifecycle";

/**
 * Tests del ciclo de vida del turno.
 *
 * Dos operaciones con una misma obsesión: que el turno NO se pueda mover a un
 * estado inválido ni a una franja inválida desde un POST armado a mano. Por eso
 * cada guard se prueba comprobando además que la base ni se toca.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

/** Builder encadenable `.update().eq().eq()` que resuelve a { error }. */
let updateError: { message: string } | null = null;
const updateEq = vi.fn();
const update = vi.fn();

function buildQuery() {
  const builder: Record<string, unknown> = {};
  builder.eq = (...args: unknown[]) => {
    updateEq(...args);
    return builder;
  };
  builder.then = (resolve: (r: { error: unknown }) => unknown) =>
    Promise.resolve(resolve({ error: updateError }));
  return builder;
}

const from = vi.fn(() => ({
  update: (values: unknown) => {
    update(values);
    return buildQuery();
  },
}));

const rpc = vi.fn(async () => ({ error: null as { message: string } | null }));
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

const booking = {
  id: "booking-1",
  customerName: "Ana",
  customerPhone: null,
  serviceName: "Corte",
  staffName: "Vale",
  startsAt: "2026-09-01T13:00:00.000Z",
  endsAt: "2026-09-01T14:00:00.000Z",
  status: "confirmed" as const,
  serviceId: "service-1",
  staffId: "staff-1",
};

const getBooking = vi.fn(async (): Promise<unknown> => ok(booking));
vi.mock("./queries", () => ({
  getBooking: () => getBooking(),
}));

function statusForm(status: string, id = "booking-1"): FormData {
  const form = new FormData();
  form.append("id", id);
  form.append("status", status);
  return form;
}

function rescheduleForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateError = null;
  rpc.mockResolvedValue({ error: null });
  getBooking.mockResolvedValue(ok(booking));
  getCurrentTenant.mockResolvedValue({ id: "tenant-1", slug: "negocio" });
});

describe("updateBookingStatusAction", () => {
  it("cierra un turno confirmado como completado", async () => {
    const result = await updateBookingStatusAction(
      idleState,
      statusForm("completed"),
    );

    expect(result.status).toBe("success");
    expect(update).toHaveBeenCalledWith({ status: "completed" });
  });

  it("filtra el UPDATE por id Y por tenant, no sólo por id", async () => {
    await updateBookingStatusAction(idleState, statusForm("cancelled"));

    expect(updateEq).toHaveBeenCalledWith("id", "booking-1");
    expect(updateEq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("rechaza una transición inválida sin tocar la base", async () => {
    getBooking.mockResolvedValue(ok({ ...booking, status: "cancelled" }));

    const result = await updateBookingStatusAction(
      idleState,
      statusForm("completed"),
    );

    expect(result.status).toBe("error");
    expect(update).not.toHaveBeenCalled();
  });

  it("rechaza un estado que no existe en el enum, sin tocar la base", async () => {
    const result = await updateBookingStatusAction(
      idleState,
      statusForm("drop table"),
    );

    expect(result.status).toBe("error");
    expect(update).not.toHaveBeenCalled();
  });

  it("frena si el turno no es del negocio, sin tocar la base", async () => {
    getBooking.mockResolvedValue(
      err(appError("booking_not_found", "No encontramos ese turno.")),
    );

    const result = await updateBookingStatusAction(
      idleState,
      statusForm("cancelled"),
    );

    expect(result.status).toBe("error");
    expect(update).not.toHaveBeenCalled();
  });

  it("si el UPDATE falla devuelve error y NO revalida nada", async () => {
    updateError = { message: "boom" };

    const result = await updateBookingStatusAction(
      idleState,
      statusForm("cancelled"),
    );

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("rescheduleBookingAction", () => {
  it("mueve el turno vía la RPC, manteniendo al profesional si no cambia", async () => {
    const result = await rescheduleBookingAction(
      idleState,
      rescheduleForm({ id: "booking-1", startsAt: "2026-09-02T13:00:00.000Z" }),
    );

    expect(result.status).toBe("success");
    expect(rpc).toHaveBeenCalledWith("reschedule_booking", {
      p_booking_id: "booking-1",
      p_starts_at: "2026-09-02T13:00:00.000Z",
      p_staff_id: null,
    });
  });

  it("manda el profesional nuevo cuando el turno cambia de manos", async () => {
    await rescheduleBookingAction(
      idleState,
      rescheduleForm({
        id: "booking-1",
        startsAt: "2026-09-02T13:00:00.000Z",
        staffId: "staff-2",
      }),
    );

    expect(rpc).toHaveBeenCalledWith("reschedule_booking", {
      p_booking_id: "booking-1",
      p_starts_at: "2026-09-02T13:00:00.000Z",
      p_staff_id: "staff-2",
    });
  });

  it("no mueve un turno ya cerrado, sin tocar la base", async () => {
    getBooking.mockResolvedValue(ok({ ...booking, status: "cancelled" }));

    const result = await rescheduleBookingAction(
      idleState,
      rescheduleForm({ id: "booking-1", startsAt: "2026-09-02T13:00:00.000Z" }),
    );

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rechaza una fecha destino que no es un instante válido", async () => {
    const result = await rescheduleBookingAction(
      idleState,
      rescheduleForm({ id: "booking-1", startsAt: "mañana a la tarde" }),
    );

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("traduce el error de cupo de la RPC a un mensaje accionable", async () => {
    rpc.mockResolvedValue({
      error: { message: "ERROR: No quedan lugares en esa franja" },
    });

    const result = await rescheduleBookingAction(
      idleState,
      rescheduleForm({ id: "booking-1", startsAt: "2026-09-02T13:00:00.000Z" }),
    );

    expect(result).toMatchObject({
      status: "error",
      message: "No quedan lugares en esa franja. Elegí otra.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("frena si no hay negocio en la sesión", async () => {
    getCurrentTenant.mockResolvedValue(null);

    const result = await rescheduleBookingAction(
      idleState,
      rescheduleForm({ id: "booking-1", startsAt: "2026-09-02T13:00:00.000Z" }),
    );

    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });
});
