import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import { appError, err, ok } from "@/core/result";

import { updateBookingStatusAction } from "./booking-lifecycle";

/**
 * Tests del ciclo de vida del turno.
 *
 * Una obsesión: que el turno NO se pueda mover a un estado inválido desde un
 * POST armado a mano. Por eso cada guard se prueba comprobando además que la
 * base ni se toca.
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from }),
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

beforeEach(() => {
  vi.clearAllMocks();
  updateError = null;
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
