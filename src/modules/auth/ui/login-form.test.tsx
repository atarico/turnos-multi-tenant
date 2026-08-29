import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginForm } from "./login-form";

/**
 * El login es la única puerta por la que pasa alguien que se olvidó la
 * contraseña: nadie va a tipear /recuperar de memoria. Sin este link, el flujo
 * entero existe y no lo encuentra nadie.
 */
vi.mock("../application/actions", () => ({
  signInAction: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("LoginForm", () => {
  it("pide email y contraseña", () => {
    render(<LoginForm />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ingresar" })).toBeInTheDocument();
  });

  it("ofrece la salida a quien se olvidó la contraseña", () => {
    render(<LoginForm />);

    expect(
      screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" }),
    ).toHaveAttribute("href", "/recuperar");
  });

  /**
   * El punto entero de la mejora: que no haya que retipear el mail.
   *
   * Se prueba el `href`, no el texto del link, porque el `href` es lo único
   * que la pantalla siguiente va a leer. Si el mail no viaja, `/recuperar`
   * pide el dato de nuevo y vuelve a abrir la puerta al typo.
   */
  it("se lleva el mail tipeado al link de recuperar", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Email"), "vos@negocio.com");

    expect(
      screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" }),
    ).toHaveAttribute("href", "/recuperar?email=vos%40negocio.com");
  });

  /** Sin nada tipeado el link queda pelado: no se manda un `email=` vacío. */
  it("deja el link sin parámetro cuando el campo está vacío", () => {
    render(<LoginForm />);

    expect(
      screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" }),
    ).toHaveAttribute("href", "/recuperar");
  });
});
