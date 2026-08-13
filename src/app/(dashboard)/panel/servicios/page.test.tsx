import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { publicBookingUrl } from "@/modules/tenants/domain/public-url";
import type { Tenant } from "@/modules/tenants/domain/types";

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/catalog/application/queries", () => ({
  listCatalogServices: vi.fn(async () => ({ ok: true, value: [] })),
}));
vi.mock("@/modules/catalog/application/actions", () => ({
  deleteServiceAction: vi.fn(),
  saveServiceAction: vi.fn(),
  toggleServiceActiveAction: vi.fn(),
}));

const tenant: Tenant = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  country: "AR",
  timezone: "America/Argentina/Buenos_Aires",
  plan: "basico",
  logo_url: null,
  brand_color: "#e3b23c",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

describe("ServicesPage", () => {
  // Timeout raised to match the sibling panel page test: same shape and the
  // same risk of flaking past the default 5000ms under full-suite contention.
  it(
    "renders the real public booking link, not a literal turnos.app string",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      process.env.NEXT_PUBLIC_APP_URL = "https://turnos.app";
      const { default: ServicesPage } = await import("./page");

      render(await ServicesPage());

      const link = screen.getByRole("link", { name: /acme/i });
      expect(link).toHaveAttribute(
        "href",
        publicBookingUrl("https://turnos.app", "acme"),
      );
    },
  );

  it(
    "warns and falls back to localhost when NEXT_PUBLIC_APP_URL is missing",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      const previous = process.env.NEXT_PUBLIC_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { default: ServicesPage } = await import("./page");

        render(await ServicesPage());

        const link = screen.getByRole("link", { name: /acme/i });
        expect(link).toHaveAttribute(
          "href",
          publicBookingUrl("http://localhost:3000", "acme"),
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("NEXT_PUBLIC_APP_URL"),
        );
      } finally {
        warn.mockRestore();
        process.env.NEXT_PUBLIC_APP_URL = previous;
      }
    },
  );
});
