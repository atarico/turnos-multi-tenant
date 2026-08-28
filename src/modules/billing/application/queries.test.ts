import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionRow } from "../domain/subscription-mapper";

import { getCurrentSubscription } from "./queries";

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
  builder.maybeSingle = async () => result;
  return builder;
}

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
   * El filtro de estados es lo ÚNICO que impide que una suscripción cancelada
   * se lea como viva. Tiene que incluir `past_due`: el cobro falló pero el
   * servicio sigue andando durante la gracia, y dejarlo afuera cortaría el
   * acceso por una tarjeta vencida.
   */
  it("sólo trae suscripciones vivas, y past_due cuenta como viva", async () => {
    await getCurrentSubscription("tenant-1");

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
