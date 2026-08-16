import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Tenant } from "@/modules/tenants/domain/types";
import { throwingRedirectSpy } from "@/test-support/next-navigation";

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));

vi.mock("@/modules/tenants/application/actions", () => ({
  updateBrandingAction: vi.fn(),
}));

const tenant: Tenant = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  country: "AR",
  timezone: "America/Argentina/Buenos_Aires",
  plan: "basico",
  logo_url: null,
  brand_color: "#e3b23c",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

describe("SettingsPage", () => {
  // Sin negocio no hay nada que configurar. El guard existe porque en App
  // Router la page corre aunque el layout muestre otra cosa.
  it("rebota al panel cuando el usuario todavía no tiene negocio", async () => {
    const { getCurrentTenant } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getCurrentTenant).mockResolvedValue(null);
    const { default: SettingsPage } = await import("./page");

    await expect(SettingsPage()).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith("/panel");
  });

  /**
   * El color que llega al formulario sale de `tenant.brand_color` (snake_case,
   * porque `Tenant` es la fila cruda del join) y no de `brandColor`. Escribir
   * mal ese nombre no rompe el render: el input queda con el color anterior y
   * el dueño ve un color que no es el suyo. Por eso se pincha el valor real.
   */
  it("le pasa al formulario el color que el negocio tiene guardado", async () => {
    const { getCurrentTenant } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
    const { default: SettingsPage } = await import("./page");

    render(await SettingsPage());

    expect(screen.getByLabelText("Color de marca")).toHaveValue("#e3b23c");
  });

  /**
   * El link público no es decoración en esta pantalla: el color se elige acá
   * pero se VE allá, así que sin el link el dueño no tiene forma de comprobar
   * lo que acaba de guardar.
   *
   * Se verifica que apunte a ESTE negocio, no la URL completa: cómo se resuelve
   * el origen (env var y su fallback) ya está cubierto en los tests del panel y
   * de `public-url`. Repetirlo acá ataría este test a una decisión que no es
   * suya y lo rompería cada vez que cambie el entorno.
   */
  it("muestra el link público para que el dueño vaya a ver el resultado", async () => {
    const { getCurrentTenant } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
    const { default: SettingsPage } = await import("./page");

    render(await SettingsPage());

    expect(screen.getByRole("link", { name: /acme/i })).toHaveAttribute(
      "href",
      expect.stringContaining(`/${tenant.slug}`),
    );
  });
});
