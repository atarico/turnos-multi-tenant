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

  it("muestra el mail que llegó por la URL para confirmarlo", async () => {
    await renderPage({ email: "vos@negocio.com" });

    expect(screen.getByText("vos@negocio.com")).toBeInTheDocument();
  });

  /**
   * El contracaso, y el que de verdad importa.
   *
   * Esta pantalla ya tenía la regla de no pintar lo que venga en la URL —por
   * eso la bandera del link vencido se compara y el texto vive en el código—.
   * El `email` es la excepción, y sólo se sostiene si pasa por el schema:
   * si se pintara crudo, cualquiera mandaría un link con la frase que se le
   * ocurra adentro de nuestro diseño y con nuestro dominio en la barra.
   */
  it("no pinta un `email` que no tiene forma de mail", async () => {
    const fraude = "Escribinos al 11-2233 para desbloquear tu cuenta";
    await renderPage({ email: fraude });

    expect(screen.queryByText(fraude)).not.toBeInTheDocument();
    // Y cae al formulario normal, que es el estado de "no sé quién sos".
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
});
