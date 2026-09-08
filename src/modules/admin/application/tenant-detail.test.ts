import { beforeEach, describe, expect, it, vi } from "vitest";

import { getTenantDetail } from "./tenant-detail";

/**
 * Tests del detalle de un negocio para el panel de plataforma.
 *
 * Son DOS consultas y tres desenlaces posibles, y lo que se prueba acá es que
 * los tres se puedan distinguir. La trampa está en el medio: "no encontré el
 * negocio" y "no pude preguntar" tienen que salir por caminos distintos,
 * porque la pantalla hace cosas opuestas con cada uno —un 404 contra un cartel
 * de error— y colapsarlos le mostraría al operador un negocio inexistente cada
 * vez que la base tose.
 */

type QueryResult = { data: unknown; error: unknown };

let tenantResult: QueryResult = { data: null, error: null };
let subscriptionResult: QueryResult = { data: null, error: null };
let clientFailure: Error | null = null;

const from = vi.fn();
const eq = vi.fn();

function builderFor(table: string) {
  const result = table === "tenants" ? tenantResult : subscriptionResult;
  const builder: Record<string, unknown> = {};
  const chainable = ["eq", "order", "limit"];
  for (const method of chainable) {
    builder[method] = (...args: unknown[]) => {
      if (method === "eq") eq(table, ...args);
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(result);
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (clientFailure) throw clientFailure;
    return {
      from: (table: string) => {
        from(table);
        return { select: () => builderFor(table) };
      },
    };
  },
}));

const tenantRow = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  country: "AR",
  plan: "basico",
  created_at: "2026-08-01T00:00:00Z",
};

const subscriptionRow = {
  id: "s1",
  tenant_id: "t1",
  plan: "premium",
  status: "active",
  current_period_start: "2026-08-01T00:00:00Z",
  current_period_end: "2026-09-01T00:00:00Z",
  trial_ends_at: null,
  price_usd_cents: 2000,
  charged_amount_cents: null,
  charged_currency: "ARS",
  fx_rate: null,
  fx_source: null,
  fx_quoted_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  tenantResult = { data: tenantRow, error: null };
  subscriptionResult = { data: null, error: null };
  clientFailure = null;
});

describe("getTenantDetail", () => {
  it("trae el negocio con su suscripción", async () => {
    subscriptionResult = { data: subscriptionRow, error: null };

    const result = await getTenantDetail("acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.tenant.name).toBe("Acme");
    expect(result.value?.subscription?.plan).toBe("premium");
    expect(result.value?.subscription?.status).toBe("active");
  });

  it("busca el negocio por slug, no por id", async () => {
    await getTenantDetail("acme");

    expect(eq).toHaveBeenCalledWith("tenants", "slug", "acme");
  });

  /**
   * La suscripción se ata al `id` que devolvió la primera consulta, no al slug.
   * Es lo único que hace que las dos consultas hablen del mismo negocio.
   */
  it("ata la suscripción al id del negocio que encontró", async () => {
    await getTenantDetail("acme");

    expect(eq).toHaveBeenCalledWith("subscriptions", "tenant_id", "t1");
  });

  it("devuelve el negocio aunque todavía no tenga suscripción", async () => {
    const result = await getTenantDetail("acme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.tenant.slug).toBe("acme");
    expect(result.value?.subscription).toBeNull();
  });

  /**
   * Un slug que no existe NO es un error: es un 404. Devolver `err` acá haría
   * que la pantalla pintara un cartel rojo de fallo de sistema ante alguien que
   * simplemente tipeó mal la URL.
   */
  it("contesta null, y no un error, cuando el negocio no existe", async () => {
    tenantResult = { data: null, error: null };

    const result = await getTenantDetail("no-existe");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("devuelve error cuando la consulta del negocio falla", async () => {
    tenantResult = { data: null, error: { message: "boom" } };

    const result = await getTenantDetail("acme");

    expect(result.ok).toBe(false);
  });

  /**
   * LA decisión de esta función, y la que la separa de `getCurrentSubscription`.
   *
   * Aquélla se traga cualquier fallo como `null` porque alimenta un cartel
   * decorativo del panel. Acá `null` significa "este negocio no está pagando", y
   * es lo que el operador mira para decidir si alguien le debe plata. Un fallo
   * de consulta disfrazado de `null` le hace creer que un cliente que paga no
   * paga. Los dos son `null` en la base; acá tienen que ser cosas distintas.
   */
  it("devuelve error cuando falla la consulta de la suscripción, sin fingir que no tiene", async () => {
    subscriptionResult = { data: null, error: { message: "boom" } };

    const result = await getTenantDetail("acme");

    expect(result.ok).toBe(false);
  });

  it("devuelve error cuando ni siquiera se pudo crear el cliente", async () => {
    clientFailure = new Error("sin cookies");

    const result = await getTenantDetail("acme");

    expect(result.ok).toBe(false);
  });
});
