import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  throwingNotFoundSpy,
  throwingRedirectSpy,
} from "@/test-support/next-navigation";

/**
 * Tests del ÚNICO guard del panel de plataforma.
 *
 * No hay una segunda reja adelante: el middleware no sabe quién es super admin
 * y las páginas de adentro asumen que si llegaron es porque este layout las
 * dejó pasar. Todo lo que se prueba acá es cuál de las cuatro puertas se abre,
 * y sobre todo que las tres cerradas se cierren de la forma exacta en que
 * fueron elegidas.
 *
 * Los dos espías TIRAN, como los `redirect()` y `notFound()` de verdad. Si
 * devolvieran `undefined`, la ejecución seguiría de largo después de la puerta
 * cerrada y el layout terminaría renderizando los children igual: el test
 * estaría probando un camino que en producción no existe, y el guard podría
 * estar roto sin que nadie se entere.
 */

const redirect = throwingRedirectSpy();
const notFound = throwingNotFoundSpy();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
  notFound: () => notFound(),
}));

let supabaseConfigured = true;
vi.mock("@/lib/supabase/config", () => ({
  isSupabaseConfigured: () => supabaseConfigured,
}));

let currentUser: { id: string } | null = { id: "u1" };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

vi.mock("@/modules/admin/application/queries", () => ({
  isSuperAdmin: vi.fn(async () => true),
}));

const children = <p>contenido de la plataforma</p>;

async function renderLayout() {
  const { default: AdminLayout } = await import("./layout");
  return AdminLayout({ children });
}

beforeEach(() => {
  vi.clearAllMocks();
  supabaseConfigured = true;
  currentUser = { id: "u1" };
});

describe("AdminLayout", () => {
  /**
   * Sin Supabase no hay a quién preguntarle si es admin. Mandar al login
   * tampoco serviría —el login también necesita Supabase—, así que la única
   * salida honesta es el cartel de setup. Lo que importa además del cartel es
   * que NI SIQUIERA se pregunte: `isSuperAdmin` levanta un cliente que no se
   * puede levantar, y aunque falla cerrado, pedirle un veredicto a algo que no
   * existe es cómo se cuelga una pantalla de desarrollo.
   */
  it(
    "muestra el cartel de setup sin preguntar por permisos",
    { timeout: 15000 },
    async () => {
      supabaseConfigured = false;
      const { isSuperAdmin } = await import(
        "@/modules/admin/application/queries"
      );

      render(await renderLayout());

      expect(screen.getByText(/falta conectar supabase/i)).toBeInTheDocument();
      expect(isSuperAdmin).not.toHaveBeenCalled();
      expect(notFound).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  /**
   * Al anónimo se le manda al login y NO se le contesta 404: todavía no sabemos
   * si es el dueño de la plataforma, y mandarlo a "esto no existe" lo dejaría
   * afuera de su propio panel por no haber iniciado sesión.
   */
  it("manda al login al visitante anónimo", { timeout: 15000 }, async () => {
    currentUser = null;

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/ingresar");
    expect(redirect).toHaveBeenCalledWith("/ingresar");
    expect(notFound).not.toHaveBeenCalled();
  });

  /**
   * LA prueba de seguridad de este archivo. Al logueado que no es admin se le
   * contesta 404 y no 403 ni un redirect: las tres cierran la puerta, pero
   * sólo el 404 no admite que la puerta existe. Un "no tenés permiso" le
   * confirma a cualquier usuario que hay un panel de plataforma y en qué URL
   * vive — la mitad del trabajo de quien busca escalar privilegios.
   *
   * Por eso no alcanza con afirmar que cortó: hay que afirmar que cortó CON
   * `notFound` y que `redirect` no se tocó. Cambiar el 404 por un redirect a
   * `/panel` sería un cambio cómodo, razonable de leer y silencioso, y es
   * exactamente lo que este test tiene que impedir.
   */
  it(
    "le contesta 404 al logueado que no es admin, nunca un redirect",
    { timeout: 15000 },
    async () => {
      const { isSuperAdmin } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(isSuperAdmin).mockResolvedValue(false);

      await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it("deja pasar al super admin", { timeout: 15000 }, async () => {
    const { isSuperAdmin } = await import("@/modules/admin/application/queries");
    vi.mocked(isSuperAdmin).mockResolvedValue(true);

    render(await renderLayout());

    expect(screen.getByText("contenido de la plataforma")).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  /**
   * Fallar cerrado, y que el `await` esté puesto.
   *
   * `isSuperAdmin` es `async`: sin el `await`, `!promiseDeFalse` es SIEMPRE
   * `false` —toda promesa es truthy— y el guard deja pasar a cualquier
   * logueado sin que nada tire ni ningún tipo se queje. Es el bug más barato
   * de escribir de todo el archivo y el más caro de tener.
   *
   * La promesa se resuelve recién en un tick posterior justamente para que un
   * `if` sin `await` no pueda dar la respuesta correcta por casualidad: cuando
   * el guard decide, el `false` todavía no existe en ningún lado más que
   * adentro de la promesa.
   */
  it(
    "niega el acceso cuando el permiso se resuelve en false, no cuando se pide",
    { timeout: 15000 },
    async () => {
      const { isSuperAdmin } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(isSuperAdmin).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(false), 0)),
      );

      await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});
