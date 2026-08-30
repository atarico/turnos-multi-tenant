import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { throwingRedirectSpy } from "@/test-support/next-navigation";

/**
 * La pantalla de la contraseña nueva.
 *
 * El guard es el punto entero: acá se cambia una contraseña sin pedir la
 * anterior, así que lo único que autoriza es la sesión que abrió el link del
 * mail. Sin sesión no se muestra el formulario —ni deshabilitado, ni vacío—
 * porque un formulario a la vista sugiere que hay algo que intentar.
 */

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

const getUser = vi.fn(async () => ({ data: { user: null as unknown } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@/modules/auth/application/actions", () => ({
  updatePasswordAction: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: null } });
});

async function renderPage() {
  const { default: Page } = await import("./page");
  render(await Page());
}

describe("NuevaContrasenaPage", () => {
  it("muestra el formulario cuando el link del mail ya abrió la sesión", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    await renderPage();

    expect(screen.getByLabelText("Contraseña nueva")).toBeInTheDocument();
    expect(screen.getByLabelText("Repetí la contraseña")).toBeInTheDocument();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sin sesión manda a pedir el link y no renderiza el formulario", async () => {
    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT:/recuperar");

    expect(redirect).toHaveBeenCalledWith("/recuperar");
    expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
  });
});
