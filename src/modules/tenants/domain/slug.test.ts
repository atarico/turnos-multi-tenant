import { describe, expect, it } from "vitest";

import { generateTenantSlug } from "./slug";

describe("generateTenantSlug", () => {
  it("builds a slug from the business name plus a random suffix", () => {
    expect(generateTenantSlug("Peluquería Martín")).toMatch(
      /^peluqueria-martin-[a-z0-9]{4}$/,
    );
  });

  it("falls back to 'negocio' when the name has no slugifiable characters", () => {
    expect(generateTenantSlug("!!!")).toMatch(/^negocio-[a-z0-9]{4}$/);
  });

  it("always produces a slug the tenants CHECK constraint accepts", () => {
    expect(generateTenantSlug("Estudio  Pilates & Co.")).toMatch(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    );
  });

  it("disambiguates two businesses sharing the same name", () => {
    expect(generateTenantSlug("Estudio Pilates")).not.toBe(
      generateTenantSlug("Estudio Pilates"),
    );
  });
});
