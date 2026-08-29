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
    render(<RecoverForm />);

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mandarme el link" }),
    ).toBeInTheDocument();
  });

  it("no pide ninguna contraseña", () => {
    render(<RecoverForm />);

    expect(screen.queryByLabelText("Contraseña")).not.toBeInTheDocument();
    expect(
      document.querySelector('input[type="password"]'),
    ).not.toBeInTheDocument();
  });
});
