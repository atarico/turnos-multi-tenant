import { beforeEach, describe, expect, it, vi } from "vitest";

import { countActiveStaff } from "./queries";

/**
 * Tests de `countActiveStaff`, que es lo que sostiene el cupo de profesionales
 * del plan. Tiene tres decisiones metidas adentro que no se ven desde afuera y
 * que se romperían sin que nada fallara: contar en la base, contar sólo
 * activos, y no confundir "no sé" con "cero".
 */

let countResult: { count: number | null; error: unknown } = {
  count: 0,
  error: null,
};

const from = vi.fn();
const select = vi.fn();
const eq = vi.fn();
const neq = vi.fn();

function chain() {
  const builder: Record<string, unknown> = {};
  builder.eq = (...args: unknown[]) => {
    eq(...args);
    return builder;
  };
  builder.neq = (...args: unknown[]) => {
    neq(...args);
    return builder;
  };
  builder.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve(resolve(countResult));
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      from(table);
      return {
        select: (columns: string, options: unknown) => {
          select(columns, options);
          return chain();
        },
      };
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  countResult = { count: 0, error: null };
});

describe("countActiveStaff", () => {
  it("devuelve el conteo que dio la base", async () => {
    countResult = { count: 4, error: null };

    const result = await countActiveStaff("tenant-1");

    expect(result).toEqual({ ok: true, value: 4 });
  });

  /**
   * El conteo lo hace Postgres y no viajan filas (`head: true`). Traerlas para
   * contarlas en la app haría que el cupo diera bien para siempre pasadas las
   * 1000 filas, porque PostgREST corta ahí sin avisar.
   */
  it("cuenta en la base, sin traer filas", async () => {
    await countActiveStaff("tenant-1");

    expect(select).toHaveBeenCalledWith("id", { count: "exact", head: true });
  });

  /**
   * Sólo cuentan los ACTIVOS: pausar a alguien libera su lugar en el plan. Es
   * la salida del negocio que bajó de plan y quedó por encima del cupo — sin
   * esto, la única forma de volver a agregar sería borrar gente.
   */
  it("cuenta sólo profesionales activos, y sólo del negocio", async () => {
    await countActiveStaff("tenant-1");

    expect(from).toHaveBeenCalledWith("staff");
    expect(eq).toHaveBeenCalledWith("tenant_id", "tenant-1");
    expect(eq).toHaveBeenCalledWith("active", true);
  });

  /**
   * `count` en null es "no sabemos", no "cero". Devolverlo como cero dejaría
   * pasar altas por encima del cupo justo cuando la consulta salió mal.
   */
  it("un conteo nulo es un error, no un cero", async () => {
    countResult = { count: null, error: null };

    const result = await countActiveStaff("tenant-1");

    expect(result.ok).toBe(false);
  });

  it("un error de la base se propaga como error", async () => {
    countResult = { count: null, error: { message: "boom" } };

    const result = await countActiveStaff("tenant-1");

    expect(result.ok).toBe(false);
  });

  /**
   * La exclusión existe para reactivar: al preguntar "¿entra este?" no hay que
   * contarlo a él. Si ya estaba activo se contaría a sí mismo y daría "límite
   * alcanzado" sobre una operación que no cambia nada.
   */
  it("puede excluir a un profesional del conteo", async () => {
    await countActiveStaff("tenant-1", "staff-1");

    expect(neq).toHaveBeenCalledWith("id", "staff-1");
  });

  it("sin exclusión no filtra por id", async () => {
    await countActiveStaff("tenant-1");

    expect(neq).not.toHaveBeenCalled();
  });
});
