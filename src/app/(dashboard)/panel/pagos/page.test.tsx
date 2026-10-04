import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { throwingRedirectSpy } from "@/test-support/next-navigation";
import type { Tenant } from "@/modules/tenants/domain/types";

/**
 * Tests de la pantalla de pagos online.
 *
 * Lo que se cuida: que cada estado diga la verdad (plan, conexión, activación),
 * que los controles sólo existan para quien puede usarlos, y que la pantalla
 * NUNCA pinte texto que venga de la URL.
 */

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));

vi.mock("@/modules/tenants/application/queries", () => ({ getCurrentTenant: vi.fn() }));
vi.mock("@/modules/payments/application/ownership", () => ({
  currentOwnerTenant: vi.fn(),
}));
vi.mock("@/modules/payments/application/queries", () => ({ getPaymentsState: vi.fn() }));
vi.mock("@/modules/payments/application/actions", () => ({
  toggleOnlinePaymentsAction: vi.fn(),
  disconnectMpAction: vi.fn(),
}));

const tenant: Tenant = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  country: "AR",
  timezone: "America/Argentina/Buenos_Aires",
  plan: "pro",
  paid_plan: "pro",
  plan_courtesy: null,
  plan_courtesy_until: null,
  plan_courtesy_reason: null,
  logo_url: null,
  brand_color: "#e3b23c",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

type State = {
  enabled: boolean;
  account: { status: "connected" | "broken"; connectedAt: string } | null;
};

const CONNECTED_AT = "2026-10-01T15:00:00Z";
const connected = (over: Partial<State> = {}): State => ({
  enabled: false,
  account: { status: "connected", connectedAt: CONNECTED_AT },
  ...over,
});

async function renderPage(
  opts: {
    tenant?: Tenant | null;
    state?: State | "error";
    owner?: boolean;
    params?: Record<string, string | string[]>;
  } = {},
) {
  const { getCurrentTenant } = await import("@/modules/tenants/application/queries");
  const { currentOwnerTenant } = await import("@/modules/payments/application/ownership");
  const { getPaymentsState } = await import("@/modules/payments/application/queries");

  vi.mocked(getCurrentTenant).mockResolvedValue(opts.tenant === undefined ? tenant : opts.tenant);
  vi.mocked(currentOwnerTenant).mockResolvedValue(
    opts.owner === false
      ? { ok: false, error: { code: "not_owner", message: "x" } }
      : { ok: true, value: { tenantId: "t1" } },
  );
  const state = opts.state ?? { enabled: false, account: null };
  vi.mocked(getPaymentsState).mockResolvedValue(
    state === "error"
      ? { ok: false, error: { code: "payments_state_failed", message: "x" } }
      : { ok: true, value: state },
  );

  const { default: Page } = await import("./page");
  render(await Page({ searchParams: Promise.resolve(opts.params ?? {}) }));
}

const T = { timeout: 15000 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PagosPage", () => {
  it("sin negocio manda al panel", T, async () => {
    const { getCurrentTenant } = await import("@/modules/tenants/application/queries");
    vi.mocked(getCurrentTenant).mockResolvedValue(null);
    const { default: Page } = await import("./page");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT:/panel",
    );
  });

  it("Básico: dice que no está disponible, enlaza a la suscripción y no ofrece conectar", T, async () => {
    await renderPage({ tenant: { ...tenant, plan: "basico", paid_plan: "basico" } });

    expect(screen.getByText(/Pro y Premium/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ver planes/i })).toHaveAttribute(
      "href",
      "/panel/suscripcion",
    );
    expect(screen.queryByRole("link", { name: /conectar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /activar/i })).not.toBeInTheDocument();
  });

  it("Básico que quedó con los pagos prendidos todavía puede apagarlos", T, async () => {
    await renderPage({
      tenant: { ...tenant, plan: "basico", paid_plan: "basico" },
      state: connected({ enabled: true }),
    });
    expect(screen.getByRole("button", { name: /desactivar/i })).toBeEnabled();
  });

  it("elegible y sin conectar: invita a conectar y el interruptor está deshabilitado", T, async () => {
    await renderPage();

    const connect = screen.getByRole("link", { name: /conectar mercado pago/i });
    expect(connect).toHaveAttribute("href", "/api/payments/mp/connect");
    expect(screen.getByRole("button", { name: /activar pagos online/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /desconectar/i })).not.toBeInTheDocument();
  });

  it("conectada y apagada: muestra la fecha y deja activar", T, async () => {
    await renderPage({ state: connected() });

    expect(screen.getByText(/conectada el 1 de octubre de 2026/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /activar pagos online/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /desconectar/i })).toBeInTheDocument();
  });

  it("conectada y prendida: dice que los clientes pagan y deja desactivar", T, async () => {
    await renderPage({ state: connected({ enabled: true }) });

    expect(screen.getByText(/pagos online están activados/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /desactivar pagos online/i })).toBeEnabled();
  });

  it("explica qué implica activar: pago completo, directo al negocio y 15 minutos", T, async () => {
    await renderPage({ state: connected() });

    const copy = document.body.textContent ?? "";
    expect(copy).toMatch(/precio completo/i);
    expect(copy).toMatch(/directo a tu cuenta de Mercado Pago/i);
    expect(copy).toMatch(/15 minutos/);
  });

  it("rota: advierte que se reserva sin pago y ofrece reconectar", T, async () => {
    await renderPage({
      state: { enabled: true, account: { status: "broken", connectedAt: CONNECTED_AT } },
    });

    expect(screen.getByText(/se rompió/i)).toBeInTheDocument();
    expect(screen.getByText(/sin pagar/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /reconectar/i })).toHaveAttribute(
      "href",
      "/api/payments/mp/connect",
    );
    // No se puede ACTIVAR sobre una cuenta rota.
    expect(screen.queryByRole("button", { name: /activar pagos online/i })).not.toBeInTheDocument();
  });

  it("quien no es dueño ve el estado pero ningún control", T, async () => {
    await renderPage({ state: connected({ enabled: true }), owner: false });

    expect(screen.getByText(/pagos online están activados/i)).toBeInTheDocument();
    expect(screen.getByText(/sólo el dueño/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /reconectar|conectar/i })).not.toBeInTheDocument();
  });

  it("si no puede leer el estado lo dice y no muestra controles", T, async () => {
    await renderPage({ state: "error" });
    expect(screen.getByText(/no pudimos leer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["conectado", /conectamos tu cuenta/i],
    ["cancelado", /cancelaste la conexión/i],
    ["error", /no pudimos conectar/i],
    ["sin-plan", /requieren el plan pro/i],
    ["desactivado", /pagos online desactivados\./i],
  ])("la bandera ?mp=%s pinta su mensaje fijo", T, async (flag, message) => {
    await renderPage({ params: { mp: flag } });
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("jamás pinta texto que venga de la URL", T, async () => {
    await renderPage({
      params: { mp: "Escribinos al WhatsApp 5555-1234 para desbloquear", error: "hackeado" },
    });
    expect(document.body.textContent).not.toContain("5555-1234");
    expect(document.body.textContent).not.toContain("hackeado");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
