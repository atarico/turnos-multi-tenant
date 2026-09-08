import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

/**
 * The hero feature chip whose text matches.
 *
 * Goes through the chip element rather than `getByText` because the label and
 * the "Próximamente" badge are siblings inside it — a text matcher would find
 * the label node alone and could never see the badge next to it.
 *
 * Targets `[data-hero-chip]` and not a class, following `[data-step]` below:
 * a class selector would pin Tailwind utilities that exist for layout, so
 * restyling the row would break a test that is about copy, not appearance.
 */
function heroChip(pattern: RegExp): HTMLElement {
  const chip = [...document.querySelectorAll("[data-hero-chip]")].find((el) =>
    pattern.test(el.textContent ?? ""),
  );
  if (!chip) throw new Error(`No hero chip matches ${pattern}`);
  return chip as HTMLElement;
}

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

  /**
   * The hero is the product's first sentence and the one Google indexes.
   *
   * WhatsApp reminders and Stripe are both sold here and neither exists:
   * `rg -ni "stripe|reminder" src` returns only this file and the layout
   * metadata. Nothing in the product sends a message or charges through
   * Stripe. Whoever reads this is deciding whether to sign up.
   *
   * Anticipating is fine; claiming is not. What is still being built has to
   * read as still being built.
   */
  it("does not present WhatsApp or Stripe as something that already works", () => {
    render(<HomePage />);

    expect(heroChip(/WhatsApp/)).toHaveTextContent(/próximamente/i);
    expect(heroChip(/Stripe/)).toHaveTextContent(/próximamente/i);
  });

  it("keeps what does work free of the pending marker", () => {
    // Mercado Pago charges real money today (see the billing module) and
    // multi-tenant is the whole product. Marking those pending would swing
    // the page from overselling to underselling itself.
    render(<HomePage />);

    expect(heroChip(/Mercado Pago/)).not.toHaveTextContent(/próximamente/i);
    expect(heroChip(/Multi-negocio/)).not.toHaveTextContent(/próximamente/i);
  });

  it("does not promise the unbuilt features in the hero prose", () => {
    // The chips carry the "Próximamente" marker next to them. A sentence in
    // running prose cannot carry that marker, so it must not make the claim
    // at all — a reader skimming the paragraph would take it as delivered.
    render(<HomePage />);

    const prose = screen.getByText(/tus clientes reservan solos/i);
    expect(prose).not.toHaveTextContent(/stripe/i);
    expect(prose).not.toHaveTextContent(/whatsapp/i);
  });
});

