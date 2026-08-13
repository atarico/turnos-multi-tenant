import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegisterForm } from "./register-form";

/**
 * El registro crea SOLO la cuenta: el nombre del negocio y el país los pide el
 * onboarding del panel. Si volvieran a aparecer acá, el usuario los cargaría
 * dos veces (y con "Confirm email" activo la primera vez se perderían).
 */
vi.mock("../application/actions", () => ({
  signUpAction: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("RegisterForm", () => {
  it("pide los datos de la cuenta", () => {
    render(<RegisterForm />);

    expect(screen.getByLabelText("Tu nombre")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Crear mi cuenta" }),
    ).toBeInTheDocument();
  });

  it("no pide nombre del negocio ni país", () => {
    render(<RegisterForm />);

    expect(screen.queryByLabelText("Nombre del negocio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("País")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
