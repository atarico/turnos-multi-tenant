import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewPasswordForm } from "./new-password-form";

/**
 * El formulario de la contraseña nueva.
 *
 * Dos reglas que se ven desde acá: pide la confirmación —único control contra
 * el typo, porque después de guardar no hay forma de volver atrás sin repetir
 * todo el flujo— y NO pide la contraseña anterior. Pedirla dejaría afuera
 * exactamente a la gente para la que se hizo esta pantalla.
 */
vi.mock("../application/actions", () => ({
  updatePasswordAction: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewPasswordForm", () => {
  it("pide la contraseña nueva y su confirmación", () => {
    render(<NewPasswordForm />);

    expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText("Repetí la contraseña")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.getByRole("button", { name: "Guardar contraseña" }),
    ).toBeInTheDocument();
  });

  it("manda los dos campos con los nombres que espera la action", () => {
    render(<NewPasswordForm />);

    expect(screen.getByLabelText("Contraseña nueva")).toHaveAttribute(
      "name",
      "password",
    );
    expect(screen.getByLabelText("Repetí la contraseña")).toHaveAttribute(
      "name",
      "passwordConfirm",
    );
  });

  it("no pide la contraseña anterior", () => {
    render(<NewPasswordForm />);

    expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
    expect(
      document.querySelector('input[autocomplete="current-password"]'),
    ).not.toBeInTheDocument();
  });
});
