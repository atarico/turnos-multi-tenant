import { beforeEach, describe, expect, it, vi } from "vitest";

import { sumMonthlyRevenue } from "./queries";

/**
 * Tests de la métrica de ingresos.
 *
 * Lo que se pinta acá es plata, así que las obsesiones son tres: que sume SÓLO
 * lo que efectivamente se cobró, que la ventana sea la del mes civil del
 * negocio y no la del servidor, y que la suma la haga la BASE — traerse las
 * filas para sumarlas en JS se rompía contra el recorte silencioso de
 * PostgREST. Cada guard comprueba además que la base no se toca cuando la
 * entrada no sirve.
 */

let rows: Array<{ total_cents: number; currency: string }> | null = [];
let queryError: { message: string } | null = null;

type RpcCall = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: typeof rows; error: typeof queryError }>;

const rpc = vi.fn<RpcCall>(async () => ({ data: rows, error: queryError }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));

/** Los argumentos con los que se llamó al RPC. */
const rpcArgs = () => rpc.mock.calls[0]![1];

beforeEach(() => {
  rows = [];
  queryError = null;
  rpc.mockClear();
});

const AR = "America/Argentina/Buenos_Aires";

describe("sumMonthlyRevenue", () => {
  // La suma tiene que salir agregada de Postgres. Si esta función volviera a
  // traer filas y sumarlas en JS, PostgREST recortaría en `max_rows` (1000) sin
  // devolver error y el mes mostraría menos plata de la real, en silencio.
  it("delegates the aggregation to the database", async () => {
    await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(rpc).toHaveBeenCalledWith("sum_monthly_revenue", expect.anything());
  });

  it("returns the total the database aggregated", async () => {
    rows = [{ total_cents: 2_050_050, currency: "ARS" }];

    const result = await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.totalCents).toBe(2_050_050);
    expect(result.ok && result.value.currency).toBe("ARS");
  });

  it("scopes the query to the tenant", async () => {
    await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(rpcArgs().p_tenant_id).toBe("tenant-1");
  });

  // La ventana sale del mes CIVIL del negocio. Un turno del 30 de septiembre a
  // las 23:00 en Buenos Aires es 1 de octubre en UTC: filtrar por el mes del
  // servidor lo movería de mes.
  it("bounds the window to the tenant's civil month, half-open", async () => {
    await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(rpcArgs().p_start).toBe("2026-09-01T03:00:00.000Z");
    expect(rpcArgs().p_end).toBe("2026-10-01T03:00:00.000Z");
  });

  it("returns zero when the month has no completed bookings", async () => {
    rows = [];

    const result = await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(result.ok && result.value.totalCents).toBe(0);
  });

  // Sumar pesos con dólares no da un número, da un invento: mejor fallar y que
  // el panel muestre "—".
  it("fails rather than adding up two different currencies", async () => {
    rows = [
      { total_cents: 800_000, currency: "ARS" },
      { total_cents: 12_000, currency: "USD" },
    ];

    const result = await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(result.ok).toBe(false);
  });

  it("fails without touching the database when the month is malformed", async () => {
    const result = await sumMonthlyRevenue("tenant-1", "2026-13", AR);

    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails when the query errors", async () => {
    queryError = { message: "boom" };

    const result = await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(result.ok).toBe(false);
  });

  it("fails when the query returns no rows at all", async () => {
    rows = null;

    const result = await sumMonthlyRevenue("tenant-1", "2026-09", AR);

    expect(result.ok).toBe(false);
  });
});
