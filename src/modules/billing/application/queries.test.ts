import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionRow } from "../domain/subscription-mapper";

import {
  countPeriodBookings,
  getCurrentSubscription,
  getLiveSubscriptionIdForCharge,
} from "./queries";

/**
 * Tests de `getCurrentSubscription`.
 *
 * Alimenta un cartel informativo del panel, así que su contrato es que un
 * fallo haga desaparecer el cartel y NUNCA rompa la pantalla. Eso incluye el
 * caso en que la consulta ni siquiera llega a hacerse: el panel la mete en un
 * `Promise.all`, y una promesa rechazada ahí se lleva puesta la página entera.
 */

let result: { data: unknown; error: unknown } = { data: null, error: null };
/** Cuando está seteado, `createClient` TIRA en vez de devolver un cliente. */
let clientFailure: Error | null = null;

const from = vi.fn();
const select = vi.fn();
const eq = vi.fn();
const inFilter = vi.fn();
const order = vi.fn();
const limit = vi.fn();

function chain() {
  const builder: Record<string, unknown> = {};
  builder.eq = (...args: unknown[]) => {
    eq(...args);
    return builder;
  };
  builder.in = (...args: unknown[]) => {
    inFilter(...args);
    return builder;
  };
  builder.order = (...args: unknown[]) => {
    order(...args);
    return builder;
  };
  builder.limit = (...args: unknown[]) => {
    limit(...args);
    return builder;
  };
  builder.maybeSingle = async () => result;
  return builder;
}

/** Lo que devuelve el RPC de conteo. Un test lo pisa por caso. */
let rpcResult: { data: unknown; error: unknown } = { data: 0, error: null };

/** Tipada con los dos argumentos reales: sin esto `vi.fn` infiere cero. */
type RpcCall = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<typeof rpcResult>;
const rpc = vi.fn<RpcCall>(async () => rpcResult);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (clientFailure) throw clientFailure;
    return {
      from: (table: string) => {
        from(table);
        return {
          select: (columns: string) => {
            select(columns);
            return chain();
          },
        };
      },
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpc(fn, args);
        return rpcResult;
      },
    };
  },
}));

/**
 * Anotado como `SubscriptionRow` A PROPÓSITO: el test de más abajo deriva de
 * este literal los nombres de columna que se esperan pedir. Sin la anotación,
 * agregar un campo a la interfaz y al mapper dejaría este fixture viejo y el
 * guardián verde mientras el campo nuevo llega `undefined`.
 */
const row: SubscriptionRow = {
  id: "sub-1",
  tenant_id: "tenant-1",
  plan: "pro",
  status: "active",
  current_period_start: "2026-08-01T00:00:00Z",
  current_period_end: "2026-09-01T00:00:00Z",
  trial_ends_at: null,
  price_usd_cents: 3500,
  charged_amount_cents: 4550000,
  charged_currency: "ARS",
  fx_rate: 1300,
  fx_source: "dolarapi:mep",
  fx_quoted_at: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  result = { data: null, error: null };
  clientFailure = null;
});

describe("getCurrentSubscription", () => {
  it("devuelve la suscripción ya mapeada al dominio", async () => {
    result = { data: row, error: null };

    const subscription = await getCurrentSubscription("tenant-1");

    expect(subscription?.id).toBe("sub-1");
    expect(subscription?.plan).toBe("pro");
    // Mapeada de verdad: si devolviera la fila cruda esto sería un string.
    expect(subscription?.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it("busca en subscriptions y filtra por el negocio", async () => {
    await getCurrentSubscription("tenant-1");

    expect(from).toHaveBeenCalledWith("subscriptions");
    expect(eq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  /**
   * NO FILTRA POR ESTADO, y ese es el cambio que trajo la baja.
   *
   * Filtrando por estados vivos, un negocio que se dio de baja leía `null` —
   * indistinguible de no tener suscripción— y las dos pantallas que dependen
   * de esto quedaban mintiendo: el panel no podía decirle hasta cuándo le
   * queda servicio, y `nueva-reserva` volvía a mostrarle el formulario cuando
   * el período venciera, para que la base se lo rechazara al enviar.
   *
   * Quién decide qué significa cada estado es el dominio (`takesNewBookings`),
   * no esta consulta. Acá se trae el HECHO; allá se lo juzga.
   *
   * El que sí conserva su filtro estricto es `getLiveSubscriptionIdForCharge`,
   * y por eso existe aparte: cobrar sobre una suscripción dada de baja es
   * exactamente lo que no puede pasar.
   */
  it("trae la suscripción sin filtrar por estado", async () => {
    await getCurrentSubscription("tenant-1");

    expect(inFilter).not.toHaveBeenCalled();
  });

  /**
   * Y trae LA MÁS NUEVA. Hoy hay una sola fila por negocio, pero el índice
   * único parcial sólo prohíbe dos VIVAS: una baja más un alta nueva son dos
   * filas legales, y sin este orden `maybeSingle()` se rompería o devolvería
   * la vieja.
   */
  it("trae la más reciente, una sola", async () => {
    await getCurrentSubscription("tenant-1");

    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("el cobro sigue exigiendo una suscripción VIVA, y past_due cuenta como viva", async () => {
    await getLiveSubscriptionIdForCharge("tenant-1");

    expect(inFilter).toHaveBeenCalledWith("status", [
      "trialing",
      "active",
      "past_due",
    ]);
  });

  /**
   * El `as unknown as SubscriptionRow` del mapeo apaga al compilador, así que
   * si la lista de columnas pierde una, nada avisa: el campo llega `undefined`
   * y el dominio opera sobre basura. Este test es el único que lo ata.
   *
   * Se compara contra los NOMBRES partidos por coma, no con `toContain` sobre
   * el string entero. Buscar la subcadena "id" adentro de "id, tenant_id, ..."
   * la encuentra igual dentro de `tenant_id`, así que sacar la columna `id`
   * pasaba el test: el guardián no guardaba nada.
   */
  it("pide todas las columnas que el mapper necesita", async () => {
    await getCurrentSubscription("tenant-1");

    const requested = (select.mock.calls[0]![0] as string)
      .split(",")
      .map((column) => column.trim());

    expect(requested).toEqual(expect.arrayContaining(Object.keys(row)));
  });

  it("sin suscripción viva devuelve null", async () => {
    result = { data: null, error: null };

    expect(await getCurrentSubscription("tenant-1")).toBeNull();
  });

  it("un error de la base devuelve null, no rompe", async () => {
    result = { data: null, error: { message: "boom" } };

    expect(await getCurrentSubscription("tenant-1")).toBeNull();
  });

  /**
   * EL CASO QUE FALTABA. El panel mete esta promesa en un `Promise.all`; si
   * acá se escapa una excepción —el cliente de Supabase no se puede crear,
   * por ejemplo— se cae la pantalla entera del panel por un cartel decorativo.
   */
  it("una excepción al crear el cliente también devuelve null", async () => {
    clientFailure = new Error("no se pudo crear el cliente");

    await expect(getCurrentSubscription("tenant-1")).resolves.toBeNull();
  });
});


/**
 * Tests del conteo de turnos del período.
 *
 * Alimenta el aviso de techo del panel. Sus dos obsesiones:
 *
 * 1. **El conteo lo hace Postgres.** Traer las filas y contarlas acá se rompe
 *    contra el `max_rows` de PostgREST, que recorta en 1000 SIN devolver
 *    error. Justo el negocio que hay que avisar —el que se pasó del techo— es
 *    el que caería del otro lado del recorte.
 *
 * 2. **Un fallo devuelve `null`, nunca cero.** Cero es un número y significa
 *    "no cargaste nada": mostrarlo cuando en realidad no pudimos contar le
 *    diría al dueño que está tranquilo justo cuando no sabemos si lo está.
 *    `null` apaga el aviso en vez de inventarlo.
 */
describe("countPeriodBookings", () => {
  const START = "2026-09-01T00:00:00.000Z";
  const END = "2026-10-01T00:00:00.000Z";

  beforeEach(() => {
    rpcResult = { data: 0, error: null };
    rpc.mockClear();
  });

  it("delega el conteo a la base", () => {
    return countPeriodBookings("tenant-1", START, END).then(() => {
      expect(rpc).toHaveBeenCalledWith(
        "count_period_bookings",
        expect.anything(),
      );
    });
  });

  it("devuelve el número que contó la base", async () => {
    rpcResult = { data: 247, error: null };

    expect(await countPeriodBookings("tenant-1", START, END)).toBe(247);
  });

  it("acota la ventana al período que se le pasa", async () => {
    await countPeriodBookings("tenant-1", START, END);

    const args = rpc.mock.calls[0]?.[1] ?? {};
    expect(args.p_start).toBe(START);
    expect(args.p_end).toBe(END);
  });

  it("consulta el negocio que se le pide y no otro", async () => {
    await countPeriodBookings("tenant-1", START, END);

    const args = rpc.mock.calls[0]?.[1] ?? {};
    expect(args.p_tenant_id).toBe("tenant-1");
  });

  it("un fallo de la base devuelve null, NO cero", async () => {
    rpcResult = { data: null, error: { message: "boom" } };

    expect(await countPeriodBookings("tenant-1", START, END)).toBeNull();
  });

  it("si no se puede ni crear el cliente, devuelve null y no rompe", async () => {
    // El panel mete esto en un `Promise.all`: una promesa rechazada acá se
    // lleva puesta la pantalla entera por un cartel informativo.
    clientFailure = new Error("sin sesión");

    await expect(
      countPeriodBookings("tenant-1", START, END),
    ).resolves.toBeNull();
  });

  it("cero turnos es cero, no un fallo", async () => {
    // El caso feliz del negocio nuevo. Tiene que distinguirse de `null`.
    rpcResult = { data: 0, error: null };

    expect(await countPeriodBookings("tenant-1", START, END)).toBe(0);
  });
});
