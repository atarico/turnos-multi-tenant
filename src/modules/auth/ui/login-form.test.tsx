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
});
