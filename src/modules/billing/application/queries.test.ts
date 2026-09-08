import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionRow } from "../domain/subscription-mapper";

import {
  countPeriodBookings,
  getCurrentSubscription,
  openSubscriptionForCharge,
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
 * El RPC del cliente ADMIN, que es otro cliente y por eso otro mock.
 *
 * `openSubscriptionForCharge` no puede usar el de sesión: la función que llama
 * ESCRIBE en `subscriptions`, que no tiene policy de INSERT para nadie, y está
 * grantada sólo a `service_role`. Un test que lo mockeara contra el cliente de
 * sesión pasaría verde contra una llamada que en producción da 403.
 */
let adminResult: { data: unknown; error: unknown } = { data: null, error: null };
/** Cuando está seteado, `createAdminClient` TIRA en vez de devolver un cliente. */
let adminFailure: Error | null = null;

type AdminRpcCall = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;
const adminRpc = vi.fn<AdminRpcCall>(async () => adminResult);

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return {
      rpc: (fn: string, args: Record<string, unknown>) => {
        adminRpc(fn, args);
        return adminResult;
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
  adminResult = { data: null, error: null };
  adminFailure = null;
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
 * Tests de `openSubscriptionForCharge`.
 *
 * Es el primer paso del checkout y el único que puede ESCRIBIR: si el negocio
 * se había dado de baja, abre la fila `incomplete` del re-alta. Lo que se
 * cuida acá no es la lógica —esa vive en la función de Postgres y la prueba
 * `supabase/tests/open_subscription_for_charge.sql`— sino el borde entre los
 * dos: que se llame a la función correcta, con el cliente correcto, y que los
 * tres desenlaces lleguen al checkout distinguidos.
 *
 * Distinguirlos es todo el punto de que devuelva `Result` y no `string | null`:
 * "la base no contestó" y "este negocio no tiene ninguna suscripción" piden
 * cosas distintas del dueño, y sobre plata esa diferencia no se puede perder.
 */
describe("openSubscriptionForCharge", () => {
  it("devuelve el id que abrió o encontró la base", async () => {
    adminResult = { data: "sub-9", error: null };

    const result = await openSubscriptionForCharge("tenant-1", "pro");

    expect(result.ok && result.value).toBe("sub-9");
  });

  /**
   * CON EL CLIENTE ADMIN, no con el de sesión.
   *
   * `open_subscription_for_charge` es `security definer` y está grantada sólo
   * a `service_role`, porque escribe en una tabla sin policy de INSERT —un
   * dueño que pudiera escribir su suscripción se pondría premium sin pagar.
   * Llamada con el cliente de sesión, esto devuelve 403 en producción y el
   * dueño no puede volver a contratar nunca.
   */
  it("llama a la función de la base con el cliente admin", async () => {
    adminResult = { data: "sub-9", error: null };

    await openSubscriptionForCharge("tenant-1", "pro");

    expect(adminRpc).toHaveBeenCalledWith("open_subscription_for_charge", {
      p_tenant_id: "tenant-1",
      p_plan: "pro",
    });
    // Y no por el cliente de sesión: ése no tiene el grant.
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * El plan viaja porque `subscriptions.plan` es `not null` y la fila del
   * re-alta hay que abrirla con alguno. Elegir uno fijo acá le guardaría al
   * dueño un plan que no apretó durante los milisegundos que tarda
   * `attach_subscription_checkout` en pisarlo — y si el checkout falla en el
   * medio, para siempre.
   */
  it("le pasa el plan que el dueño eligió", async () => {
    adminResult = { data: "sub-9", error: null };

    await openSubscriptionForCharge("tenant-1", "premium");

    expect(adminRpc.mock.calls[0]![1]).toMatchObject({ p_plan: "premium" });
  });

  /**
   * `null` es el negocio sin NINGUNA fila, que es un estado roto y no un caso
   * normal: `create_business` abre la suscripción en la misma transacción que
   * el negocio. Se distingue del error de base porque al dueño le pasa otra
   * cosa y tiene que leer otra cosa.
   */
  it("sin ninguna suscripción devuelve subscription_not_found", async () => {
    adminResult = { data: null, error: null };

    const result = await openSubscriptionForCharge("tenant-1", "pro");

    expect(!result.ok && result.error.code).toBe("subscription_not_found");
  });

  it("un error de la base NO se confunde con no tener suscripción", async () => {
    adminResult = { data: null, error: { message: "boom" } };

    const result = await openSubscriptionForCharge("tenant-1", "pro");

    expect(!result.ok && result.error.code).toBe("subscription_query_failed");
  });

  /**
   * EL CAMINO QUE TIRA, no el que devuelve error. `createAdminClient()`
   * revienta si falta la service-role key, y mirar sólo `result.error` lo deja
   * afuera: el dueño vería un crash del framework en vez de un mensaje. Es el
   * mismo aprendizaje que ya está escrito en `checkout.ts` y en `cancel.ts`.
   */
  it("una excepción al crear el cliente admin vuelve como error legible", async () => {
    adminFailure = new Error("falta la service-role key");

    const result = await openSubscriptionForCharge("tenant-1", "pro");

    expect(!result.ok && result.error.code).toBe("subscription_query_failed");
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
