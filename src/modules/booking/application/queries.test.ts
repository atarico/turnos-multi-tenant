import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  countBookingsOnDay,
  getBooking,
  listUpcomingBookings,
  sumMonthlyRevenue,
} from "./queries";

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

/**
 * Doble mínimo del query builder encadenable de Supabase (`.select().eq()...`).
 * El cliente real es "thenable" al final de la cadena (sin un terminal
 * explícito) para listas, y expone `.maybeSingle()` para una sola fila — acá
 * replicamos exactamente eso, nada más.
 */
let fromData: unknown = [];
let fromError: { message: string } | null = null;
/**
 * Lo que devuelve una consulta `head: true`: sin filas, sólo el total que contó
 * Postgres. `null` es la respuesta real de PostgREST cuando no se pidió conteo.
 */
let fromCount: number | null = null;

interface Builder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (
    resolve: (v: {
      data: unknown;
      error: typeof fromError;
      count: number | null;
    }) => unknown,
  ) => unknown;
}

function makeBuilder(): Builder {
  const builder = {} as Builder;
  for (const method of ["select", "eq", "in", "gte", "lt", "order"] as const) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => ({ data: fromData, error: fromError }));
  builder.then = (resolve) =>
    Promise.resolve({
      data: fromData,
      error: fromError,
      count: fromCount,
    }).then(resolve);
  return builder;
}

const from = vi.fn(() => makeBuilder());

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc, from }),
}));

/** Los argumentos con los que se llamó al RPC. */
const rpcArgs = () => rpc.mock.calls[0]![1];

/** El builder de la última consulta `.from(...)`. */
const lastBuilder = () =>
  from.mock.results[from.mock.results.length - 1]!.value as Builder;

/** La cadena `.select(...)` con la que se armó la última consulta `.from(...)`. */
const lastSelect = () => lastBuilder().select.mock.calls[0]![0] as string;

/** Las opciones de `.select(cols, opciones)` — ahí viaja el `count`/`head`. */
const lastSelectOptions = () =>
  lastBuilder().select.mock.calls[0]![1] as
    | { count?: string; head?: boolean }
    | undefined;

/** El primer argumento con que se llamó a un filtro de la última consulta. */
const filterArg = (method: "eq" | "in" | "gte" | "lt", index = 0) =>
  lastBuilder()[method].mock.calls[index]?.[1] as unknown;

beforeEach(() => {
  rows = [];
  queryError = null;
  rpc.mockClear();
  fromData = [];
  fromError = null;
  fromCount = null;
  from.mockClear();
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

/**
 * Tests del contador "Turnos hoy".
 *
 * La métrica responde "cuánto trabajo tiene el día", no "cuánto queda por
 * delante": por eso la ventana es el día civil COMPLETO del negocio y no
 * arranca en `now()`. Antes el panel filtraba la lista de próximos turnos, que
 * corta en `starts_at >= now()`: a las 23:00 los dos turnos de las 23:00 ya
 * habían arrancado, se habían mudado a "turnos a cerrar" y el contador decía 0.
 *
 * Igual que en ingresos, el conteo lo hace la BASE: contar filas traídas se
 * rompe contra el `max_rows` de PostgREST (1000) sin devolver error.
 */
describe("countBookingsOnDay", () => {
  it("delegates the count to the database instead of fetching rows", async () => {
    await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(lastSelectOptions()).toMatchObject({ count: "exact", head: true });
  });

  it("returns the count the database reported", async () => {
    fromCount = 7;

    const result = await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(7);
  });

  it("scopes the query to the tenant", async () => {
    await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(filterArg("eq")).toBe("tenant-1");
  });

  // El defecto original: un turno de las 23:00 visto a las 23:00 ya arrancó y
  // ya terminó. Sigue siendo trabajo de hoy, así que sigue contando — la cota
  // baja es la medianoche del negocio, nunca `now()`.
  it("counts a booking that already started and ended earlier today", async () => {
    await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(filterArg("gte")).toBe("2026-09-15T03:00:00.000Z");
  });

  // Y la cota alta es exclusiva: el turno de mañana a las 00:00 es de mañana.
  it("stops at the start of the next civil day, exclusive", async () => {
    await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(filterArg("lt")).toBe("2026-09-16T03:00:00.000Z");
  });

  // El día lo decide la timezone del NEGOCIO, no la del servidor: el mismo
  // "2026-09-15" empieza y termina en otro instante en Santiago que en Buenos
  // Aires, y el contador tiene que moverse con el negocio.
  it("lets the tenant's timezone decide the day boundary", async () => {
    await countBookingsOnDay("tenant-1", "2026-09-15", "Pacific/Auckland");

    expect(filterArg("gte")).toBe("2026-09-14T12:00:00.000Z");
    expect(filterArg("lt")).toBe("2026-09-15T12:00:00.000Z");
  });

  // 'completed' cuenta: el turno pasó, el trabajo lo tuvo el día igual.
  // 'cancelled'/'no_show' no: son trabajo que el día NO tuvo.
  it("counts completed bookings but not cancelled or no-show ones", async () => {
    await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    const statuses = filterArg("in") as string[];
    expect(statuses).toContain("completed");
    expect(statuses).toContain("pending");
    expect(statuses).toContain("confirmed");
    expect(statuses).not.toContain("cancelled");
    expect(statuses).not.toContain("no_show");
  });

  it("fails without touching the database when the day is malformed", async () => {
    const result = await countBookingsOnDay("tenant-1", "2026-02-30", AR);

    expect(result.ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it("fails when the query errors", async () => {
    fromError = { message: "boom" };

    const result = await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(result.ok).toBe(false);
  });

  // Sin conteo no hay número: un 0 inventado es un dato falso, y el panel
  // prefiere admitir que no pudo leer.
  it("fails when the database reports no count at all", async () => {
    fromCount = null;

    const result = await countBookingsOnDay("tenant-1", "2026-09-15", AR);

    expect(result.ok).toBe(false);
  });
});

/**
 * Mapeo de nombre de servicio/profesional en la agenda.
 *
 * `service_name`/`staff_name` son una foto congelada en el turno (igual que
 * `price_cents`), no el nombre VIVO de `services`/`staff`: por eso se leen
 * directo de la fila y nunca con un fallback tipo `"—"` — la columna es
 * `NOT NULL` desde el momento en que el turno se crea, borrar el
 * servicio/profesional después no la vacía.
 */
describe("listUpcomingBookings", () => {
  it("reads the snapshot names frozen on the booking row", async () => {
    fromData = [
      {
        id: "b1",
        customer_name: "Ana",
        customer_phone: null,
        starts_at: "2026-09-01T10:00:00Z",
        ends_at: "2026-09-01T10:30:00Z",
        status: "confirmed",
        service_name: "Corte",
        staff_name: "Juan",
      },
    ];

    const result = await listUpcomingBookings("tenant-1");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value[0]?.serviceName).toBe("Corte");
    expect(result.ok && result.value[0]?.staffName).toBe("Juan");
  });

  it("selects the snapshot columns instead of the live services/staff joins", async () => {
    await listUpcomingBookings("tenant-1");

    const select = lastSelect();
    expect(select).toContain("service_name");
    expect(select).toContain("staff_name");
    expect(select).not.toContain("services(");
    expect(select).not.toContain("staff(");
  });
});

describe("getBooking", () => {
  it("returns null serviceId/staffId for a booking unlinked from a deleted parent", async () => {
    fromData = {
      id: "b1",
      customer_name: "Ana",
      customer_phone: null,
      starts_at: "2026-09-01T10:00:00Z",
      ends_at: "2026-09-01T10:30:00Z",
      status: "cancelled",
      service_name: "Corte",
      staff_name: "Juan",
      service_id: null,
      staff_id: null,
    };

    const result = await getBooking("tenant-1", "b1");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.serviceId).toBeNull();
    expect(result.ok && result.value.staffId).toBeNull();
    // El nombre sobrevive congelado aunque el vínculo se haya cortado.
    expect(result.ok && result.value.serviceName).toBe("Corte");
    expect(result.ok && result.value.staffName).toBe("Juan");
  });

  it("returns the live serviceId/staffId for a still-linked booking", async () => {
    fromData = {
      id: "b1",
      customer_name: "Ana",
      customer_phone: null,
      starts_at: "2026-09-01T10:00:00Z",
      ends_at: "2026-09-01T10:30:00Z",
      status: "confirmed",
      service_name: "Corte",
      staff_name: "Juan",
      service_id: "service-1",
      staff_id: "staff-1",
    };

    const result = await getBooking("tenant-1", "b1");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.serviceId).toBe("service-1");
    expect(result.ok && result.value.staffId).toBe("staff-1");
  });
});
