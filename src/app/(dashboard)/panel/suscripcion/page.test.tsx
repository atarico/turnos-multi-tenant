import { render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { throwingRedirectSpy } from "@/test-support/next-navigation";
import type { Subscription } from "@/modules/billing/domain/subscription";
import type { Tenant } from "@/modules/tenants/domain/types";

/**
 * Tests de la pantalla de suscripción.
 *
 * Es la que abre el cobro Y la que recibe al pagador que vuelve de Mercado
 * Pago. Lo que se cuida acá es que no mienta: volver del checkout NO es haber
 * pagado, y decirlo al revés deja al dueño creyendo que contrató algo que
 * todavía no se cobró.
 */

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/billing/application/queries", () => ({
  getCurrentSubscription: vi.fn(async () => null),
}));
vi.mock("@/modules/billing/application/actions", () => ({
  startCheckoutAction: vi.fn(),
}));

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

const DAY = 86_400_000;

const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  id: "sub-1",
  tenantId: tenant.id,
  plan: "pro",
  status: "active",
  currentPeriodStart: new Date(Date.now() - DAY),
  currentPeriodEnd: new Date(Date.now() + 29 * DAY),
  trialEndsAt: null,
  priceUsdCents: 3500,
  chargedAmountCents: 5_250_000,
  chargedCurrency: "ARS",
  fxRate: 1500,
  fxSource: "dolarapi:bolsa",
  fxQuotedAt: new Date(),
  ...over,
});

async function renderPage(
  params: Record<string, string> = {},
  negocio: Tenant = tenant,
) {
  const { getCurrentTenant } = await import(
    "@/modules/tenants/application/queries"
  );
  vi.mocked(getCurrentTenant).mockResolvedValue(negocio);

  const { default: Page } = await import("./page");
  render(await Page({ searchParams: Promise.resolve(params) }));
}

// Timeout ampliado en todos: cada test renderiza el Server Component entero y
// bajo contención de CPU en la suite completa pasa de los 5000ms por defecto.
describe("SuscripcionPage", () => {
  it("manda al panel cuando la cuenta todavía no tiene negocio, para que él decida el destino", { timeout: 15000 }, async () => {
    const { getCurrentTenant } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getCurrentTenant).mockResolvedValue(null);
    const { default: Page } = await import("./page");

    await expect(
      Page({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT:/panel");
  });

  it("muestra los tres planes", { timeout: 15000 }, async () => {
    await renderPage();

    // Por `heading` y no por texto: el nombre del plan aparece DOS veces en la
    // pantalla —en la tarjeta de "Tu plan hoy" y en la del plan— y eso es
    // correcto. Buscar por texto pelado confundiría las dos.
    for (const label of ["Básico", "Pro", "Premium"]) {
      expect(
        screen.getByRole("heading", { name: label, level: 3 }),
      ).toBeInTheDocument();
    }
  });

  it("durante la prueba dice cuántos días quedan", { timeout: 15000 }, async () => {
    const { getCurrentSubscription } = await import(
      "@/modules/billing/application/queries"
    );
    vi.mocked(getCurrentSubscription).mockResolvedValue(
      subscription({
        plan: "basico",
        status: "trialing",
        trialEndsAt: new Date(Date.now() + 3 * DAY),
      }),
    );

    await renderPage();

    expect(screen.getByText(/3 días/i)).toBeInTheDocument();
  });

  it("con el plan pagando, bloquea volver a contratarlo", { timeout: 15000 }, async () => {
    // Contratarlo de nuevo abriría una SEGUNDA suscripción que también cobra.
    const { getCurrentSubscription } = await import(
      "@/modules/billing/application/queries"
    );
    vi.mocked(getCurrentSubscription).mockResolvedValue(
      subscription({ plan: "pro", status: "active" }),
    );

    await renderPage();

    expect(screen.getByRole("button", { name: /plan actual/i })).toBeDisabled();
  });

  it("avisa cuando el cobro falló y corre la gracia", { timeout: 15000 }, async () => {
    const { getCurrentSubscription } = await import(
      "@/modules/billing/application/queries"
    );
    vi.mocked(getCurrentSubscription).mockResolvedValue(
      subscription({ status: "past_due" }),
    );

    await renderPage();

    expect(screen.getByText(/no pudimos cobrar/i)).toBeInTheDocument();
  });

  it("al volver de Mercado Pago NO dice que ya está pago", { timeout: 15000 }, async () => {
    // ES EL PUNTO DE LA PANTALLA. El redirect de vuelta no prueba nada: quien
    // activa es el webhook cuando el cobro entra. Decir "listo, ya está" acá
    // es mentirle al dueño, y encima se puede falsear poniendo el parámetro a
    // mano en la URL.
    await renderPage({ preapproval_id: "MP-PREAPPROVAL-1" });

    expect(
      screen.getByText(/la activación se confirma cuando Mercado Pago/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ya está activo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pago confirmado/i)).not.toBeInTheDocument();
  });

  it("sin poder leer la suscripción se pinta igual", { timeout: 15000 }, async () => {
    // `getCurrentSubscription` devuelve null tanto si no hay como si la base
    // no contestó. La pantalla tiene que seguir ofreciendo los planes: dejar
    // al dueño sin forma de pagar por un fallo de lectura es peor.
    const { getCurrentSubscription } = await import(
      "@/modules/billing/application/queries"
    );
    vi.mocked(getCurrentSubscription).mockResolvedValue(null);

    await renderPage();

    expect(
      screen.getAllByRole("button", { name: /contratar/i }),
    ).toHaveLength(3);
  });

  /**
   * Tests de la cortesía vista por el DUEÑO.
   *
   * Desde el panel de plataforma un regalo se ve completo —plan, motivo, quién
   * lo dio—. Desde acá lo único que importa son dos preguntas que el dueño
   * necesita poder contestar: por qué tengo este plan si no lo pago, y qué pasa
   * cuando se termine. Un plan mejor sin explicación se lee como algo comprado,
   * y el día que caduca el negocio cree que le sacaron algo.
   */
  /** El cartel de cortesía, por su texto ancla. Tira si no está. */
  function avisoDeCortesia(): HTMLElement {
    return screen.getByText(/cortesía/i).closest("p") as HTMLElement;
  }

  describe("con una cortesía", () => {
    const conCortesia: Tenant = {
      ...tenant,
      plan: "premium",
      paid_plan: "basico",
      plan_courtesy: "premium",
      plan_courtesy_reason: "beta tester",
    };

    it(
      "avisa que el plan es de cortesía y a cuál vuelve",
      { timeout: 15000 },
      async () => {
        await renderPage({}, conCortesia);

        // El cartel mezcla texto y <b>, así que el texto vive partido en varios
        // nodos y un getByText por frase no lo encuentra aunque esté en pantalla.
        // Se afirma sobre el textContent del cartel entero.
        expect(avisoDeCortesia().textContent).toMatch(/cortesía/i);
        expect(avisoDeCortesia().textContent).toMatch(/vuelve a Básico/i);
      },
    );

    it(
      "sin vencimiento, lo dice en vez de dejarlo en blanco",
      { timeout: 15000 },
      async () => {
        await renderPage({}, { ...conCortesia, plan_courtesy_until: null });

        expect(avisoDeCortesia().textContent).toMatch(/no tiene fecha de fin/i);
      },
    );

    /**
     * La fecha se pinta en UTC, y la zona del proceso se fija a mano para que
     * eso se PRUEBE en vez de salir bien de casualidad.
     *
     * Medianoche UTC del 1 de diciembre son las 21hs del 30 de noviembre en
     * Buenos Aires. Sin el TZDate, el operador elige un día y el dueño lee el
     * anterior. En una máquina en UTC este test pasaría igual con el bug
     * puesto: por eso la zona no se deja al azar de dónde corra la suite.
     */
    describe("con el proceso en horario argentino", () => {
      const tzOriginal = process.env.TZ;
      beforeAll(() => {
        process.env.TZ = "America/Argentina/Buenos_Aires";
      });
      afterAll(() => {
        process.env.TZ = tzOriginal;
      });

      it(
        "con vencimiento, dice el día que se pactó y no el anterior",
        { timeout: 15000 },
        async () => {
          await renderPage({}, {
            ...conCortesia,
            plan_courtesy_until: "2026-12-01T00:00:00.000Z",
          });

          const texto = avisoDeCortesia().textContent ?? "";
          expect(texto).toMatch(/hasta el 1 de diciembre/i);
          expect(texto).not.toMatch(/30 de noviembre/i);
        },
      );
    });

    /**
     * EL BUG QUE ESTE CAMBIO ARREGLA.
     *
     * El picker marcaba como "Tu plan" el plan EFECTIVO, y lo bloqueaba cuando
     * había un cobro abierto. Un negocio que paga básico con una cortesía
     * premium veía premium bloqueado como si lo estuviera pagando, básico sin
     * marcar, y no podía cambiar de plan.
     *
     * El picker habla de la relación comercial: lo que marca es lo que se paga.
     * La cortesía se explica arriba, en su propio cartel.
     */
    it(
      "el selector marca el plan que se PAGA, no el regalado",
      { timeout: 15000 },
      async () => {
        await renderPage({}, conCortesia);

        const marca = screen.getByText("Tu plan");
        const tarjeta = marca.closest("div")?.parentElement;
        expect(tarjeta).not.toBeNull();
        expect(within(tarjeta as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe("Básico");
      },
    );

    it(
      "sin cortesía no aparece ningún cartel de regalo",
      { timeout: 15000 },
      async () => {
        await renderPage({}, tenant);

        expect(screen.queryByText(/cortesía/i)).toBeNull();
      },
    );
  });
});
