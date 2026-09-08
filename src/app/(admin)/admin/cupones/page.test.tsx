import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Coupon } from "@/modules/admin/domain/coupon";

vi.mock("@/modules/admin/application/coupons", () => ({
  listCoupons: vi.fn(),
}));
vi.mock("@/modules/admin/application/coupon-actions", () => ({
  createCouponAction: vi.fn(),
  toggleCouponAction: vi.fn(),
}));

const coupon: Coupon = {
  code: "BETA99",
  discount_bps: 9900,
  active: true,
  expires_at: null,
  max_redemptions: null,
  redemptions: 0,
  note: "prueba de cobro real",
  created_at: "2026-08-01T00:00:00Z",
};

async function mockList(value: Coupon[], options: { ok?: boolean } = {}) {
  const { listCoupons } = await import("@/modules/admin/application/coupons");
  vi.mocked(listCoupons).mockResolvedValue(
    options.ok === false
      ? {
          ok: false,
          error: {
            code: "admin_coupons_query_failed",
            message: "No pudimos cargar los cupones.",
          },
        }
      : { ok: true, value },
  );
}

async function renderPage() {
  const { default: Page } = await import("./page");
  return render(await Page());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CuponesPage", () => {
  it("lista los cupones", { timeout: 15000 }, async () => {
    await mockList([coupon]);

    await renderPage();

    expect(screen.getByText("BETA99")).toBeInTheDocument();
    expect(screen.getByText("prueba de cobro real")).toBeInTheDocument();
  });

  it("deja volver a los negocios", { timeout: 15000 }, async () => {
    await mockList([]);

    await renderPage();

    expect(screen.getByRole("link", { name: /negocios/i })).toHaveAttribute(
      "href",
      "/admin",
    );
  });

  /**
   * Un fallo de consulta NO se pinta como "no hay cupones". El siguiente paso
   * obvio del operador sería crear uno que ya existe, y el código chocaría —
   * después de haberlo mandado a un cliente.
   */
  it(
    "pinta el error, y no una lista vacía, cuando la consulta falla",
    { timeout: 15000 },
    async () => {
      await mockList([], { ok: false });

      await renderPage();

      expect(screen.getByText(/no pudimos cargar los cupones/i)).toBeInTheDocument();
      expect(screen.queryByText(/todavía no hay cupones/i)).toBeNull();
    },
  );

  it(
    "con la lista vacía sí dice que no hay ninguno",
    { timeout: 15000 },
    async () => {
      await mockList([]);

      await renderPage();

      expect(screen.getByText(/todavía no hay cupones/i)).toBeInTheDocument();
      expect(screen.queryByText(/no pudimos cargar/i)).toBeNull();
    },
  );
});
