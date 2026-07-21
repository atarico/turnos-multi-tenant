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
});
