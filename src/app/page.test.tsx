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
});
