import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { throwingNotFoundSpy } from "@/test-support/next-navigation";
import type { AdminTenantDetail } from "@/modules/admin/domain/types";
import type { Subscription } from "@/modules/billing/domain/subscription";

/**
 * Tests del detalle de un negocio visto desde la plataforma.
 *
 * La pantalla existe para contestar UNA pregunta: ¿lo que el negocio tiene y lo
 * que su suscripción paga dicen lo mismo? Todo lo demás es contexto para poder
 * contestarla. Por eso la mayoría de los casos de acá son sobre la discrepancia
 * y sobre los tres desenlaces de la consulta, no sobre el maquetado.
 */

const notFound = throwingNotFoundSpy();
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));

vi.mock("@/modules/admin/application/tenant-detail", () => ({
  getTenantDetail: vi.fn(),
}));

const subscription: Subscription = {
  id: "s1",
  tenantId: "t1",
  plan: "premium",
  status: "active",
  currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  trialEndsAt: null,
  priceUsdCents: 2000,
  chargedAmountCents: null,
  chargedCurrency: "ARS",
  fxRate: null,
  fxSource: null,
  fxQuotedAt: null,
};

const detail: AdminTenantDetail = {
  tenant: {
    id: "t1",
    slug: "acme",
    name: "Acme",
    country: "AR",
    plan: "premium",
    created_at: "2026-08-01T00:00:00Z",
  },
  subscription,
};

async function mockDetail(
  value: AdminTenantDetail | null,
  options: { ok?: boolean } = {},
) {
  const { getTenantDetail } = await import(
    "@/modules/admin/application/tenant-detail"
  );
  vi.mocked(getTenantDetail).mockResolvedValue(
    options.ok === false
      ? { ok: false, error: { code: "boom", message: "No pudimos cargar el detalle de este negocio." } }
      : { ok: true, value },
  );
}

async function renderPage() {
  const { default: Page } = await import("./page");
  return render(await Page({ params: Promise.resolve({ slug: "acme" }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminTenantDetailPage", () => {
  it("muestra el nombre y el slug del negocio", { timeout: 15000 }, async () => {
    await mockDetail(detail);

    await renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "Acme" }),
    ).toBeInTheDocument();
    expect(screen.getByText("/acme")).toBeInTheDocument();
  });

  it("pone los dos planes uno al lado del otro", { timeout: 15000 }, async () => {
    await mockDetail(detail);

    await renderPage();

    expect(screen.getByText("Plan del negocio")).toBeInTheDocument();
    expect(screen.getByText("Plan de la suscripción")).toBeInTheDocument();
  });

  /**
   * El caso que la pantalla existe para encontrar. Ya pasó en el sandbox: un
   * segundo checkout dejó al negocio en un plan y al preapproval que cobra en
   * otro, y desde la lista se veía un negocio perfectamente normal.
   */
  it(
    "avisa cuando el plan del negocio y el de la suscripción no coinciden",
    { timeout: 15000 },
    async () => {
      await mockDetail({
        ...detail,
        tenant: { ...detail.tenant, plan: "basico" },
      });

      await renderPage();

      expect(screen.getByText(/no coinciden/i)).toBeInTheDocument();
    },
  );

  it(
    "no avisa nada cuando los dos planes coinciden",
    { timeout: 15000 },
    async () => {
      await mockDetail(detail);

      await renderPage();

      expect(screen.queryByText(/no coinciden/i)).toBeNull();
    },
  );

  /**
   * Una cancelada con otro plan es lo NORMAL de alguien que bajó de categoría.
   * Marcarla haría sonar la alarma en un caso sano, y una alarma que suena sin
   * motivo deja de mirarse.
   */
  it(
    "no avisa cuando el plan distinto viene de una suscripción cancelada",
    { timeout: 15000 },
    async () => {
      await mockDetail({
        tenant: { ...detail.tenant, plan: "basico" },
        subscription: { ...subscription, status: "canceled" },
      });

      await renderPage();

      expect(screen.queryByText(/no coinciden/i)).toBeNull();
    },
  );

  it(
    "dice que no hay suscripción en vez de dejar el hueco vacío",
    { timeout: 15000 },
    async () => {
      await mockDetail({ ...detail, subscription: null });

      await renderPage();

      expect(screen.getByText(/sin suscripción/i)).toBeInTheDocument();
    },
  );

  /**
   * Un slug que no existe es un 404, no un cartel de error: quien tipeó mal la
   * URL no tiene que ver una pantalla que sugiere que el sistema se rompió.
   */
  it("hace 404 cuando el negocio no existe", { timeout: 15000 }, async () => {
    await mockDetail(null);

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  /**
   * Y al revés: un fallo de consulta NO puede terminar en 404. Le diría al
   * operador que un negocio que sí existe no existe, y lo mandaría a buscar
   * media hora un problema que no está donde parece.
   */
  it(
    "pinta el error, y no un 404, cuando la consulta falla",
    { timeout: 15000 },
    async () => {
      await mockDetail(null, { ok: false });

      await renderPage();

      expect(screen.getByText(/no pudimos cargar/i)).toBeInTheDocument();
      expect(notFound).not.toHaveBeenCalled();
    },
  );

  it("deja volver a la lista", { timeout: 15000 }, async () => {
    await mockDetail(detail);

    await renderPage();

    expect(screen.getByRole("link", { name: /negocios/i })).toHaveAttribute(
      "href",
      "/admin",
    );
  });
});
