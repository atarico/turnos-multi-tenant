import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoverForm } from "./recover-form";

/**
 * El formulario que pide el mail de recuperación.
 *
 * Pide UNA cosa y nada más: el email. Cualquier campo extra acá sería un dato
 * que se le exige a alguien que, por definición, no puede probar quién es
 * todavía.
 */
vi.mock("../application/actions", () => ({
  requestPasswordResetAction: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("RecoverForm", () => {
  it("pide el email y ofrece mandar el link", () => {
    render(<RecoverForm knownEmail={null} />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mandarme el link" }),
    ).toBeInTheDocument();
  });

  /**
   * El estado que existe cuando se llega desde `/ingresar` con el mail ya
   * tipeado. Lo que se prueba no es que el texto aparezca: es que el valor
   * llegue al action IGUAL que en el otro estado, porque si el `hidden` no
   * viaja, el formulario se manda vacío y falla sin que se vea por qué.
   */
  it("confirma el mail conocido y lo manda en el submit", () => {
    render(<RecoverForm knownEmail="vos@negocio.com" />);

    expect(screen.getByText("vos@negocio.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sí, es mío: mandame el link" }),
    ).toBeInTheDocument();

    const hidden = document.querySelector('input[name="email"]');
    expect(hidden).toHaveAttribute("type", "hidden");
    expect(hidden).toHaveValue("vos@negocio.com");
  });

  /** La salida para quien mira el mail y no es el suyo. */
  it("ofrece volver a ingresar cuando el mail no es el propio", () => {
    render(<RecoverForm knownEmail="otro@negocio.com" />);

    expect(
      screen.getByRole("link", { name: "No es mi mail, volver atrás" }),
    ).toHaveAttribute("href", "/ingresar");
  });

  /**
   * Confirmar no puede convertirse en retipear: si además del texto quedara un
   * campo editable, se le estaría pidiendo de nuevo el único dato que ya
   * estaba bien, que es justo donde entra el typo que rompe todo el flujo.
   */
  it("no vuelve a pedir el mail cuando ya lo sabe", () => {
    render(<RecoverForm knownEmail="vos@negocio.com" />);

    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("no pide ninguna contraseña", () => {
    render(<RecoverForm knownEmail={null} />);

    expect(screen.queryByLabelText("Contraseña")).not.toBeInTheDocument();
    expect(
      document.querySelector('input[type="password"]'),
    ).not.toBeInTheDocument();
  });
});
