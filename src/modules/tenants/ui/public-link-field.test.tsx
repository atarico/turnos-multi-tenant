import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicLinkField } from "./public-link-field";

const URL = "https://turnos.app/acme";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PublicLinkField", () => {
  it("muestra el link sin el esquema y apunta a la URL completa", () => {
    render(<PublicLinkField url={URL} />);

    const link = screen.getByRole("link", { name: "turnos.app/acme" });
    expect(link).toHaveAttribute("href", URL);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("copia la URL completa, no la etiqueta recortada", async () => {
    const user = userEvent.setup();
    render(<PublicLinkField url={URL} />);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));

    expect(writeText).toHaveBeenCalledWith(URL);
  });

  it("confirma que copió", async () => {
    const user = userEvent.setup();
    render(<PublicLinkField url={URL} />);

    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));

    expect(
      await screen.findByRole("button", { name: "Copiado" }),
    ).toBeInTheDocument();
  });

  // El portapapeles puede estar denegado: el link sigue visible y seleccionable,
  // así que el fallo no tiene que romper nada ni mentir con un "Copiado".
  it("no rompe ni confirma cuando el portapapeles falla", async () => {
    const user = userEvent.setup();
    render(<PublicLinkField url={URL} />);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("clipboard denied"),
    );

    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));

    expect(
      screen.getByRole("button", { name: "Copiar enlace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copiado" }),
    ).not.toBeInTheDocument();
  });
});
