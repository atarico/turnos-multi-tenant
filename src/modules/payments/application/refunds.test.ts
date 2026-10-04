import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pagos a devolver. Se leen con la SESIÓN (RLS: un miembro ve los pagos y los
 * turnos de su negocio), en dos consultas porque cada una tiene su propio
 * filtro en la base: mezclarlas en una sola traería todos los 'approved' del
 * negocio y chocaría con el tope de 1000 filas de PostgREST sin avisar.
 */

interface Call {
  select: string;
  eq: Array<[string, unknown]>;
}
const calls: Call[] = [];
let extraResult: { data: unknown; error: unknown } = { data: [], error: null };
let primaryResult: { data: unknown; error: unknown } = { data: [], error: null };
let sessionThrows = false;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (sessionThrows) throw new Error("boom");
    return {
      from: (table: string) => {
        const call: Call = { select: "", eq: [] };
        calls.push(call);
        const chain = {
          select: (cols: string) => {
            call.select = `${table}:${cols}`;
            return chain;
          },
          eq: (col: string, val: unknown) => {
            call.eq.push([col, val]);
            return chain;
          },
          // Cada consulta termina en `await`: la del pago extra filtra por 'refund_due'.
          then: (resolve: (r: unknown) => unknown) =>
            resolve(
              call.eq.some(([c, v]) => c === "status" && v === "refund_due")
                ? extraResult
                : primaryResult,
            ),
        };
        return chain;
      },
    };
  },
}));

const { listPaymentsToRefund } = await import("./refunds");

const row = (over: Record<string, unknown>) => ({
  id: "p1",
  booking_id: "b1",
  mp_payment_id: "mp-1",
  amount_cents: 150000,
  currency: "ARS",
  bookings: { customer_name: "Ana", starts_at: "2026-10-10T13:00:00Z" },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  extraResult = { data: [], error: null };
  primaryResult = { data: [], error: null };
  sessionThrows = false;
});

describe("listPaymentsToRefund", () => {
  it("lista el pago extra (fila refund_due) con cliente, fecha, monto y id de MP", async () => {
    extraResult = { data: [row({})], error: null };

    const result = await listPaymentsToRefund("t1");

    expect(result.ok && result.value).toEqual([
      {
        id: "p1",
        bookingId: "b1",
        customerName: "Ana",
        startsAt: "2026-10-10T13:00:00Z",
        amountCents: 150000,
        currency: "ARS",
        mpPaymentId: "mp-1",
        kind: "extra",
      },
    ]);
  });

  it("lista el pago principal: la fila approved de un turno refund_due", async () => {
    primaryResult = { data: [row({ id: "p2", mp_payment_id: "mp-2" })], error: null };

    const result = await listPaymentsToRefund("t1");

    expect(result.ok && result.value).toMatchObject([{ id: "p2", kind: "primary" }]);
  });

  it("filtra en la base: por negocio, por estado y por el estado de pago del turno", async () => {
    await listPaymentsToRefund("t1");

    const [extra, primary] = calls;
    expect(extra?.eq).toContainEqual(["tenant_id", "t1"]);
    expect(extra?.eq).toContainEqual(["status", "refund_due"]);
    expect(primary?.eq).toContainEqual(["tenant_id", "t1"]);
    expect(primary?.eq).toContainEqual(["status", "approved"]);
    expect(primary?.eq).toContainEqual(["bookings.payment_status", "refund_due"]);
    // Embed !inner: sin él el filtro del turno no descartaría las filas.
    expect(primary?.select).toContain("bookings!inner");
  });

  it("ordena por fecha del turno, la más próxima primero", async () => {
    extraResult = {
      data: [row({ id: "late", bookings: { customer_name: "B", starts_at: "2026-10-20T10:00:00Z" } })],
      error: null,
    };
    primaryResult = {
      data: [row({ id: "soon", bookings: { customer_name: "A", starts_at: "2026-10-05T10:00:00Z" } })],
      error: null,
    };

    const result = await listPaymentsToRefund("t1");

    expect(result.ok && result.value.map((r) => r.id)).toEqual(["soon", "late"]);
  });

  it("un pago sin id de MP se lista igual, con el id en null", async () => {
    extraResult = { data: [row({ mp_payment_id: null })], error: null };

    const result = await listPaymentsToRefund("t1");

    expect(result.ok && result.value[0]?.mpPaymentId).toBeNull();
  });

  it.each(["extra", "primary"])("un error de la consulta %s falla, no devuelve una lista parcial", async (which) => {
    if (which === "extra") extraResult = { data: null, error: { message: "x" } };
    else primaryResult = { data: null, error: { message: "x" } };

    const result = await listPaymentsToRefund("t1");

    expect(result.ok).toBe(false);
  });

  it("si el cliente de sesión tira, falla con un error de dominio", async () => {
    sessionThrows = true;

    const result = await listPaymentsToRefund("t1");

    expect(result.ok).toBe(false);
  });
});
