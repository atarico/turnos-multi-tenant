import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de la desambiguación de "esta cuenta no tiene negocio".
 *
 * La misma condición significa dos cosas opuestas según quién la cumpla, y
 * hasta ahora sólo se contemplaba una. Estos tests fijan las dos.
 */

vi.mock("./queries", () => ({
  isSuperAdmin: vi.fn(),
}));

async function mockSuperAdmin(value: boolean) {
  const { isSuperAdmin } = await import("./queries");
  vi.mocked(isSuperAdmin).mockResolvedValue(value);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("landingWithoutTenant", () => {
  it("manda al operador de plataforma al panel de administración", async () => {
    await mockSuperAdmin(true);

    const { landingWithoutTenant } = await import("./landing");

    expect(await landingWithoutTenant()).toBe("/admin");
  });

  it("manda a la bienvenida a quien recién se registra", async () => {
    await mockSuperAdmin(false);

    const { landingWithoutTenant } = await import("./landing");

    expect(await landingWithoutTenant()).toBe("/panel/bienvenida");
  });

  /**
   * `isSuperAdmin()` ya falla cerrado por dentro: un error de la RPC devuelve
   * `false` en vez de tirar. Esta assertion no prueba eso de nuevo, prueba que
   * acá NO se agregue una segunda interpretación del `false` — que un día
   * alguien lea "no pudimos confirmar que sea admin" como "entonces mandalo a
   * /admin por las dudas". El destino de un `false` es el onboarding, venga de
   * donde venga.
   */
  it("con un false trata a la cuenta como recién llegada, sin excepciones", async () => {
    await mockSuperAdmin(false);

    const { landingWithoutTenant } = await import("./landing");

    expect(await landingWithoutTenant()).not.toBe("/admin");
  });

  /**
   * El operador no es miembro de ningún negocio POR DISEÑO (la migración
   * `20260828120003_platform_admins.sql` lo dice explícitamente), así que este
   * camino es el único que tiene. Si alguien invierte la condición, el operador
   * queda encerrado en un formulario que le pide crear un negocio que no
   * quiere, y el panel de plataforma vuelve a ser inalcanzable.
   */
  it("consulta el rol una sola vez por decisión", async () => {
    await mockSuperAdmin(true);
    const { isSuperAdmin } = await import("./queries");

    const { landingWithoutTenant } = await import("./landing");
    await landingWithoutTenant();

    expect(isSuperAdmin).toHaveBeenCalledTimes(1);
  });
});
