import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * La pantalla que pide el mail de recuperación.
 *
 * También es el aterrizaje de los links rotos: el route handler manda acá con
 * `?link=vencido` cuando el token no sirve. Ese cartel es todo lo que separa
 * "el link venció, pedí otro" de "la app se rompió y no sé qué hacer".
 */
vi.mock("@/modules/auth/application/actions", () => ({
  requestPasswordResetAction: vi.fn(),
}));

async function renderPage(params: Record<string, string> = {}) {
  const { default: Page } = await import("./page");
  render(await Page({ searchParams: Promise.resolve(params) }));
}

describe("RecuperarPage", () => {
  it("pide el email", async () => {
    await renderPage();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("explica que el link venció cuando el route handler la manda con la bandera", async () => {
    await renderPage({ link: "vencido" });

    expect(screen.getByText(/venció o ya se usó/i)).toBeInTheDocument();
  });

  it("no muestra el aviso en la visita normal", async () => {
    await renderPage();

    expect(screen.queryByText(/venció o ya se usó/i)).not.toBeInTheDocument();
  });

  // El valor de la bandera se compara, no se muestra: si se pintara lo que
  // viene en la URL, cualquiera podría mandar un link con el cartel que
  // quisiera —"tu cuenta fue bloqueada, escribinos a…"— y usar nuestra propia
  // pantalla de login para el engaño.
  it("ignora un valor inventado en la bandera", async () => {
    await renderPage({ link: "tu-cuenta-fue-bloqueada" });

    expect(screen.queryByText(/tu-cuenta-fue-bloqueada/)).not.toBeInTheDocument();
    expect(screen.queryByText(/venció o ya se usó/i)).not.toBeInTheDocument();
  });
});
