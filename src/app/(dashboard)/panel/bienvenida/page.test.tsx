import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tenant } from "@/modules/tenants/domain/types";

// `redirect()` real corta el render lanzando: si el mock devolviera undefined
// la page seguiría renderizando el onboarding a alguien que ya tiene negocio.
const redirect = vi.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/auth/application/queries", () => ({
  getCurrentUserName: vi.fn(),
}));
// El formulario es cliente y arrastraría la server action (y con ella el
// cliente de Supabase) al importarse: acá sólo importa que renderice.
vi.mock("@/modules/tenants/application/actions", () => ({
  createBusinessAction: vi.fn(),
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

async function mockSession(options: {
  tenant: Tenant | null;
  name?: string | null;
}) {
  const { getCurrentTenant } = await import(
    "@/modules/tenants/application/queries"
  );
  const { getCurrentUserName } = await import(
    "@/modules/auth/application/queries"
  );
  vi.mocked(getCurrentTenant).mockResolvedValue(options.tenant);
  vi.mocked(getCurrentUserName).mockResolvedValue(options.name ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WelcomePage", () => {
  it(
    "manda al panel cuando la cuenta ya tiene negocio",
    { timeout: 15000 },
    async () => {
      await mockSession({ tenant });
      const { default: WelcomePage } = await import("./page");

      await expect(WelcomePage()).rejects.toThrow("NEXT_REDIRECT:/panel");
      expect(redirect).toHaveBeenCalledWith("/panel");
    },
  );

  it(
    "pide el nombre del negocio y el país",
    { timeout: 15000 },
    async () => {
      await mockSession({ tenant: null });
      const { default: WelcomePage } = await import("./page");

      render(await WelcomePage());

      expect(screen.getByLabelText("Nombre del negocio")).toBeInTheDocument();
      expect(screen.getByLabelText("País")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Crear negocio" }),
      ).toBeInTheDocument();
    },
  );

  it(
    "saluda por nombre a quien recién creó la cuenta",
    { timeout: 15000 },
    async () => {
      await mockSession({ tenant: null, name: "Ana" });
      const { default: WelcomePage } = await import("./page");

      render(await WelcomePage());

      expect(
        screen.getByRole("heading", { level: 1, name: /Ana/ }),
      ).toBeInTheDocument();
    },
  );

  it(
    "saluda igual cuando no hay nombre guardado",
    { timeout: 15000 },
    async () => {
      await mockSession({ tenant: null, name: null });
      const { default: WelcomePage } = await import("./page");

      render(await WelcomePage());

      expect(
        screen.getByRole("heading", { level: 1, name: /bienvenida/i }),
      ).toBeInTheDocument();
    },
  );

  it(
    "explica que al crear el negocio se genera el link público de reservas",
    { timeout: 15000 },
    async () => {
      await mockSession({ tenant: null });
      const { default: WelcomePage } = await import("./page");

      render(await WelcomePage());

      expect(
        screen.getByText(/link público de reservas/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/recibir turnos/i)).toBeInTheDocument();
    },
  );
});
