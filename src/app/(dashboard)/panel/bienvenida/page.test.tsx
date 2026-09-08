import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { throwingRedirectSpy } from "@/test-support/next-navigation";
import { ONBOARDING_PATH } from "@/modules/admin/application/landing";
import type { Tenant } from "@/modules/tenants/domain/types";

const redirect = throwingRedirectSpy();
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
// Sólo se reemplaza la decisión. Las constantes se dejan pasar de verdad: si el
// mock inventara su propia ONBOARDING_PATH, el test compararía contra un valor
// que no es el que corre en producción y la comparación quedaría probando nada.
vi.mock("@/modules/admin/application/landing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/admin/application/landing")
  >()),
  landingWithoutTenant: vi.fn(),
}));

async function mockLanding(destination: string) {
  const { landingWithoutTenant } = await import(
    "@/modules/admin/application/landing"
  );
  vi.mocked(landingWithoutTenant).mockResolvedValue(destination);
}

const tenant: Tenant = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  country: "AR",
  timezone: "America/Argentina/Buenos_Aires",
  plan: "basico",
  paid_plan: "basico",
  plan_courtesy: null,
  plan_courtesy_until: null,
  plan_courtesy_reason: null,
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

beforeEach(async () => {
  vi.clearAllMocks();
  // Por defecto, quien llega sin negocio es alguien recién registrado: ésta es
  // su pantalla y no la tiene que abandonar.
  await mockLanding(ONBOARDING_PATH);
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

  /**
   * Sin este guard, un operador que escribe la URL a mano —o que llega acá
   * rebotado desde `/panel`— ve el formulario de alta y puede crearse un
   * negocio sin querer. Y si lo crea, deja de ser "sin negocio": `/panel` ya no
   * lo manda más a `/admin` y el panel de plataforma se le cierra solo.
   */
  it(
    "manda al panel de plataforma cuando quien llega es un operador",
    { timeout: 15000 },
    async () => {
      await mockSession({ tenant: null });
      await mockLanding("/admin");
      const { default: WelcomePage } = await import("./page");

      await expect(WelcomePage()).rejects.toThrow("NEXT_REDIRECT:/admin");
      expect(redirect).toHaveBeenCalledWith("/admin");
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
