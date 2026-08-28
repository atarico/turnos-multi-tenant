import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("renders the #como-funciona target for the 'Ver cómo funciona' CTA", () => {
    const { container } = render(<HomePage />);

    const section = container.querySelector("#como-funciona");
    expect(section).not.toBeNull();
  });

  it("has three or fewer steps", () => {
    const { container } = render(<HomePage />);

    const section = container.querySelector("#como-funciona");
    const steps = section?.querySelectorAll("[data-step]") ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(3);
  });

  it("keeps the CTA pointing at the section", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("link", { name: "Ver cómo funciona" }),
    ).toHaveAttribute("href", "#como-funciona");
  });

  // A <button> nested in an <a> is invalid HTML: the button becomes the
  // activation target and swallows the anchor's native hash navigation.
  it("renders the hash CTA as a plain anchor, with no nested button", () => {
    render(<HomePage />);

    const link = screen.getByRole("link", { name: "Ver cómo funciona" });
    expect(link).toHaveAttribute("href", "#como-funciona");
    expect(link.querySelector("button")).toBeNull();
  });

  it("renders the nav links as plain anchors, with no nested button", () => {
    render(<HomePage />);

    const ingresar = screen.getByRole("link", { name: "Ingresar" });
    expect(ingresar).toHaveAttribute("href", "/ingresar");
    expect(ingresar.querySelector("button")).toBeNull();

    // The nav signup CTA is the one without the arrow icon; the hero one has it.
    const navSignup = screen
      .getAllByRole("link", { name: "Crear mi negocio" })
      .find((el) => !el.querySelector("svg"));
    expect(navSignup).toBeDefined();
    expect(navSignup).toHaveAttribute("href", "/registro");
    expect(navSignup?.querySelector("button")).toBeNull();
  });

  it("renders the hero signup CTA as a plain anchor, with no nested button", () => {
    render(<HomePage />);

    // The hero CTA is the one carrying the arrow icon; the nav one has no icon.
    const link = screen
      .getAllByRole("link", { name: "Crear mi negocio" })
      .find((el) => el.querySelector("svg"));
    expect(link).toBeDefined();
    expect(link).toHaveAttribute("href", "/registro");
    expect(link?.querySelector("button")).toBeNull();
  });
});
