import { describe, expect, it } from "vitest";

import { toPublicTenant } from "./tenant-mapper";

describe("toPublicTenant", () => {
  it("maps a public_tenants row to camelCase, dropping panel-only fields", () => {
    const row = {
      id: "t1",
      slug: "acme-salon",
      name: "Acme Salon",
      timezone: "America/Argentina/Buenos_Aires",
      brand_color: "#0ea5e9",
      logo_url: "https://cdn.example.com/logo.png",
    };

    expect(toPublicTenant(row)).toEqual({
      id: "t1",
      slug: "acme-salon",
      name: "Acme Salon",
      timezone: "America/Argentina/Buenos_Aires",
      brandColor: "#0ea5e9",
      logoUrl: "https://cdn.example.com/logo.png",
    });
  });

  it("maps a null logo_url to null", () => {
    const row = {
      id: "t2",
      slug: "otro-negocio",
      name: "Otro Negocio",
      timezone: "America/Santiago",
      brand_color: "#111111",
      logo_url: null,
    };

    expect(toPublicTenant(row).logoUrl).toBeNull();
  });
});
