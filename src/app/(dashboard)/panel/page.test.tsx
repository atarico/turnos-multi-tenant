import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { publicBookingUrl } from "@/modules/tenants/domain/public-url";
import type { Tenant } from "@/modules/tenants/domain/types";

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/booking/application/queries", () => ({
  listUpcomingBookings: vi.fn(async () => ({ ok: true, value: [] })),
  listBookingsToClose: vi.fn(async () => ({ ok: true, value: [] })),
  sumMonthlyRevenue: vi.fn(async () => ({
    ok: true,
    value: { totalCents: 0, currency: "ARS" },
  })),
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

describe("PanelPage", () => {
  // Timeout raised: this test measures ~5.0s under full-suite CPU contention
  // (passes in ~2.9s isolated), so the default 5000ms flakes intermittently.
  it(
    "renders the real public booking link, not a literal turnos.app string",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      process.env.NEXT_PUBLIC_APP_URL = "https://turnos.app";
      const { default: PanelPage } = await import("./page");

      render(
        await PanelPage({
          searchParams: Promise.resolve({}),
        }),
      );

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
        const { default: PanelPage } = await import("./page");

        render(
          await PanelPage({
            searchParams: Promise.resolve({}),
          }),
        );

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
