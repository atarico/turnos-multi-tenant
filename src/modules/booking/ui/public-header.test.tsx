import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PublicHeader } from "./public-header";

describe("PublicHeader", () => {
  it("shows the business name as a heading", () => {
    render(
      <PublicHeader name="Barbería Acme" logoUrl={null} brandColor="#e3b23c" />,
    );

    expect(
      screen.getByRole("heading", { name: "Barbería Acme" }),
    ).toBeInTheDocument();
  });

  it("renders the logo image when a logoUrl is provided", () => {
    render(
      <PublicHeader
        name="Acme"
        logoUrl="https://cdn.test/logo.png"
        brandColor="#e3b23c"
      />,
    );

    const logo = screen.getByRole("img", { name: "Acme" });
    expect(logo).toHaveAttribute("src", "https://cdn.test/logo.png");
    // With a real logo there is no initial-letter fallback.
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });

  it("falls back to the uppercased name initial when there is no logo", () => {
    render(<PublicHeader name="acme" logoUrl={null} brandColor="#123456" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  /**
   * El color de marca tiene que verse SIEMPRE, no sólo cuando el negocio no
   * subió logo. Antes el único uso era el fondo del cuadradito con la inicial:
   * con logo cargado, el color elegido desaparecía por completo de la página.
   */
  it("keeps the brand colour visible even when a logo replaces the initial", () => {
    render(
      <PublicHeader
        name="Acme"
        logoUrl="https://cdn.test/logo.png"
        brandColor="#123456"
      />,
    );

    const accent = screen.getByText("Reservá tu turno");
    expect(accent).toHaveStyle({ backgroundColor: "#123456" });
  });

  /**
   * El color lo elige el negocio, así que un color de texto fijo deja ilegible
   * a la mitad de las opciones. Se calcula contra el fondo real.
   */
  it("picks dark text on a light brand colour and light text on a dark one", () => {
    const { unmount } = render(
      <PublicHeader name="Acme" logoUrl={null} brandColor="#ffff00" />,
    );
    expect(screen.getByText("Reservá tu turno")).toHaveStyle({
      color: "#000000",
    });
    unmount();

    render(<PublicHeader name="Acme" logoUrl={null} brandColor="#1e293b" />);
    expect(screen.getByText("Reservá tu turno")).toHaveStyle({
      color: "#ffffff",
    });
  });

  /**
   * Fondo y texto tienen que caer JUNTOS. Si sólo cayera el texto, el navegador
   * descartaría el fondo inválido y quedaría texto blanco sobre el fondo de la
   * página. Defensivo, pero esta página la ven los clientes del negocio.
   */
  it("falls back to a usable pair when the stored colour is not a colour", () => {
    render(
      <PublicHeader name="Acme" logoUrl={null} brandColor="rgb(1,2,3); evil" />,
    );

    expect(screen.getByText("Reservá tu turno")).toHaveStyle({
      backgroundColor: "#6366f1",
    });
  });
});
