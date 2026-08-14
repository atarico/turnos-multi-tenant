import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Tenant } from "@/modules/tenants/domain/types";

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/catalog/application/queries", () => ({
  listCatalogServices: vi.fn(async () => ({ ok: true, value: [] })),
}));
vi.mock("@/modules/staff/application/queries", () => ({
  listStaffMembers: vi.fn(async () => ({ ok: true, value: [] })),
}));
// Las actions arrastrarían el cliente de Supabase al importarse: acá sólo
// importa lo que la pantalla pinta.
vi.mock("@/modules/staff/application/actions", () => ({
  deleteStaffAction: vi.fn(),
  saveStaffAction: vi.fn(),
  toggleStaffActiveAction: vi.fn(),
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

describe("StaffPage", () => {
  it(
    "cruza al catálogo sin pasar por el panel",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      expect(screen.getByRole("link", { name: "Servicios" })).toHaveAttribute(
        "href",
        "/panel/servicios",
      );
    },
  );

  it(
    "vuelve al panel general con un único control, ya no con la flecha suelta",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      expect(
        screen.getByRole("link", { name: "Volver al panel general" }),
      ).toHaveAttribute("href", "/panel");
      expect(screen.queryByRole("link", { name: "Panel" })).toBeNull();
    },
  );
});
