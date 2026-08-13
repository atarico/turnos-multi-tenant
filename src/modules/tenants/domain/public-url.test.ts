import { describe, expect, it } from "vitest";

import { displayBookingUrl, publicBookingUrl } from "./public-url";

describe("publicBookingUrl", () => {
  it("joins the origin and the slug with a single slash", () => {
    expect(publicBookingUrl("https://turnos.app", "acme")).toBe(
      "https://turnos.app/acme",
    );
  });

  it("normalizes a trailing slash on the origin", () => {
    expect(publicBookingUrl("https://turnos.app/", "acme")).toBe(
      "https://turnos.app/acme",
    );
  });

  it("normalizes a leading slash on the slug", () => {
    expect(publicBookingUrl("https://turnos.app", "/acme")).toBe(
      "https://turnos.app/acme",
    );
  });

  it("works with the local dev default origin", () => {
    expect(publicBookingUrl("http://localhost:3000", "acme")).toBe(
      "http://localhost:3000/acme",
    );
  });
});

describe("displayBookingUrl", () => {
  it("strips the https protocol for display", () => {
    expect(displayBookingUrl("https://turnos.app/acme")).toBe(
      "turnos.app/acme",
    );
  });

  it("strips the http protocol for display", () => {
    expect(displayBookingUrl("http://localhost:3000/acme")).toBe(
      "localhost:3000/acme",
    );
  });
});
