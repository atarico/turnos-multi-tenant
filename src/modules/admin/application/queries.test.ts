import { beforeEach, describe, expect, it, vi } from "vitest";

import { isSuperAdmin, listAllTenants } from "./queries";

/**
 * Tests de las dos consultas del panel de plataforma.
 *
 * Las dos leen con el cliente de sesión, o sea que la RLS es la que decide qué
 * vuelve. Lo que se prueba acá no es el aislamiento —eso lo garantiza la base—
 * sino las DOS FORMAS DE ERROR distintas que eligió cada función, que son
 * opuestas a propósito y se romperían sin que nada explotara:
 *
 * - `isSuperAdmin` se traga cualquier fallo como `false`. Es un guard de ruta:
 *   si tira, el layout devuelve un 500 en vez de un 404, y ese 500 le confirma
 *   a un desconocido logueado que acá abajo hay algo.
 * - `listAllTenants` NO se traga nada. Es la única vista de la plataforma; una
 *   lista vacía por un fallo de consulta le diría al dueño que no hay negocios.
 */

let rpcResult: { data: unknown; error: unknown } = { data: false, error: null };
let rpcFailure: Error | null = null;
let tenantsResult: { data: unknown; error: unknown } = { data: [], error: null };
/** Cuando está seteado, `createClient` TIRA en vez de devolver un cliente. */
let clientFailure: Error | null = null;

const rpc = vi.fn();
const from = vi.fn();
const select = vi.fn();
const order = vi.fn();

function chain() {
  const builder: Record<string, unknown> = {};
  builder.order = (...args: unknown[]) => {
    order(...args);
    return builder;
  };
  // Thenable en vez de un método terminal: el builder de PostgREST se resuelve
  // con el `await`, y encadenar otro `.order()` después tiene que seguir siendo
  // posible. Un `.then` falso es lo único que reproduce las dos cosas.
  builder.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve(resolve(tenantsResult));
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (clientFailure) throw clientFailure;
    return {
      rpc: (fn: string) => {
        rpc(fn);
        if (rpcFailure) throw rpcFailure;
        return Promise.resolve(rpcResult);
      },
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

beforeEach(() => {
  vi.clearAllMocks();
  rpcResult = { data: false, error: null };
  rpcFailure = null;
  tenantsResult = { data: [], error: null };
  clientFailure = null;
});

describe("isSuperAdmin", () => {
  it("es true cuando el RPC dice que sí", async () => {
    rpcResult = { data: true, error: null };

    await expect(isSuperAdmin()).resolves.toBe(true);
  });

  it("es false cuando el RPC dice que no", async () => {
    rpcResult = { data: false, error: null };

    await expect(isSuperAdmin()).resolves.toBe(false);
  });

  /** El nombre del RPC es el contrato con la migración; si cambia, esto avisa. */
  it("pregunta por is_super_admin y no por otra cosa", async () => {
    await isSuperAdmin();

    expect(rpc).toHaveBeenCalledWith("is_super_admin");
  });

  /**
   * Un error de PostgREST NO es un permiso. Devolver algo distinto de `false`
   * ante la duda es la única falla que importa acá: abre la puerta.
   */
  it("niega el acceso si el RPC devuelve error", async () => {
    rpcResult = { data: null, error: { message: "permission denied" } };

    await expect(isSuperAdmin()).resolves.toBe(false);
  });

  /**
   * El `try` tiene que abarcar también la creación del cliente, no sólo la
   * llamada: sin configuración, `createClient` tira antes de que exista un
   * `error` que mirar. Una promesa rechazada acá le devuelve un 500 al
   * desconocido logueado, y un 500 en una ruta que "no existe" la delata.
   */
  it("niega el acceso si ni siquiera se pudo crear el cliente", async () => {
    clientFailure = new Error("faltan las variables de entorno");

    await expect(isSuperAdmin()).resolves.toBe(false);
  });

  it("niega el acceso si la llamada al RPC tira", async () => {
    rpcFailure = new Error("network");

    await expect(isSuperAdmin()).resolves.toBe(false);
  });

  /**
   * El `=== true` de la función sólo se llega a evaluar cuando NO vino error, y
   * hasta acá el único caso raro que probábamos (`data: null`) traía error
   * puesto: el `if (error)` cortaba antes y la comparación estricta no se
   * ejecutaba nunca. O sea que el `=== true` estaba escrito pero no probado, y
   * relajarlo a un truthy no habría roto ningún test.
   *
   * Estos tres son la contracara: `error: null` y un `data` que no es el
   * boolean que el RPC promete. Un `1` o un `"t"` son truthy, así que con un
   * `if (data)` los tres darían `true` y le abrirían el panel de plataforma a
   * quien mande la respuesta rara. Un `data` que no entendemos no es un sí.
   */
  it.each([
    { label: "null", data: null },
    { label: 'el string "t"', data: "t" },
    { label: "el número 1", data: 1 },
  ])("niega el acceso si el RPC devuelve $label sin error", async ({ data }) => {
    rpcResult = { data, error: null };

    await expect(isSuperAdmin()).resolves.toBe(false);
  });
});

describe("listAllTenants", () => {
  it("devuelve los negocios que trajo la base", async () => {
    tenantsResult = {
      data: [
        {
          id: "t2",
          slug: "nuevo",
          name: "Nuevo",
          country: "MX",
          plan: "pro",
          created_at: "2026-08-02T00:00:00Z",
        },
        {
          id: "t1",
          slug: "viejo",
          name: "Viejo",
          country: "AR",
          plan: "basico",
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
      error: null,
    };

    const result = await listAllTenants();

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.map((t) => t.slug)).toEqual([
      "nuevo",
      "viejo",
    ]);
  });

  /**
   * Del más nuevo al más viejo: el alta reciente es la que el dueño de la
   * plataforma está buscando cuando entra, no la primera de la historia.
   */
  it("pide los negocios ordenados por alta descendente", async () => {
    await listAllTenants();

    expect(from).toHaveBeenCalledWith("tenants");
    expect(select).toHaveBeenCalledWith(
      "id, slug, name, country, plan, created_at",
    );
    expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  /**
   * LA prueba de esta función. Un fallo tiene que ser distinguible de "todavía
   * no hay ningún negocio": las dos alternativas pintan una pantalla sin filas,
   * y sólo una de ellas es cierta.
   */
  it("distingue un fallo de una plataforma sin negocios", async () => {
    tenantsResult = { data: null, error: { message: "boom" } };
    const failure = await listAllTenants();

    tenantsResult = { data: [], error: null };
    const empty = await listAllTenants();

    expect(failure.ok).toBe(false);
    expect(empty).toEqual({ ok: true, value: [] });
  });

  /**
   * `data: null` SIN error es la única razón por la que existe el `?? []` de
   * la función, y hasta acá no se probaba: el test de arriba manda `null` pero
   * con error puesto, así que sale por la rama del `err` y el fallback ni se
   * toca. PostgREST puede contestar así, y confundirlo con un fallo sería el
   * error opuesto al que esta función se cuida de cometer: gritar "no pudimos
   * cargar los negocios" cuando la respuesta fue perfectamente válida.
   */
  it("trata un data nulo sin error como plataforma vacía, no como fallo", async () => {
    tenantsResult = { data: null, error: null };

    const result = await listAllTenants();

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("no explota si no se pudo crear el cliente", async () => {
    clientFailure = new Error("faltan las variables de entorno");

    const result = await listAllTenants();

    expect(result.ok).toBe(false);
  });
});
