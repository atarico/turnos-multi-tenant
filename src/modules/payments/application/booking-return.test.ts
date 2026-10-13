import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBookingForReturn } from "./booking-return";

const eqs: [string, string][] = [];
let result: { data: unknown; error: unknown } = { data: null, error: null };
let adminFailure: Error | null = null;
const select = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    const chain = {
      select: (cols: string) => {
        select(cols);
        return chain;
      },
      eq: (col: string, val: string) => {
        eqs.push([col, val]);
        return chain;
      },
      maybeSingle: async () => result,
    };
    return { from: () => chain };
  },
}));

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  eqs.length = 0;
  adminFailure = null;
  result = { data: null, error: null };
  vi.clearAllMocks();
});

describe("getBookingForReturn", () => {
  it("busca por id Y por negocio, y devuelve sólo lo mínimo, en camelCase", async () => {
    result = {
      data: {
        id: ID,
        status: "pending",
        payment_status: "awaiting",
        payment_expires_at: "2026-10-04T12:15:00Z",
        service_name: "Corte",
        starts_at: "2026-10-05T13:00:00Z",
      },
      error: null,
    };

    const res = await getBookingForReturn("t-1", ID);

    expect(eqs).toEqual([["id", ID], ["tenant_id", "t-1"]]);
    expect(select.mock.calls[0]![0]).not.toMatch(/customer|email|phone|notes/);
    expect(res).toEqual({
      ok: true,
      value: {
        id: ID,
        status: "pending",
        paymentStatus: "awaiting",
        paymentExpiresAt: "2026-10-04T12:15:00Z",
        serviceName: "Corte",
        startsAt: "2026-10-05T13:00:00Z",
      },
    });
  });

  it("un turno que no existe (o es de otro negocio) es ok con null", async () => {
    await expect(getBookingForReturn("t-1", ID)).resolves.toEqual({ ok: true, value: null });
  });

  it("un id que no es uuid ni toca la base", async () => {
    adminFailure = new Error("no debería crearse");
    await expect(getBookingForReturn("t-1", "no-es-uuid")).resolves.toEqual({ ok: true, value: null });
  });

  it("un error de la base es un Result de error, no una excepción", async () => {
    result = { data: null, error: { message: "boom" } };
    await expect(getBookingForReturn("t-1", ID)).resolves.toMatchObject({
      ok: false,
      error: { code: "booking_load_failed" },
    });

    adminFailure = new Error("falta la key");
    await expect(getBookingForReturn("t-1", ID)).resolves.toMatchObject({ ok: false });
  });
});
