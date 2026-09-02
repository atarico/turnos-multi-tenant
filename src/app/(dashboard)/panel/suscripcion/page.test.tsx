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
  countPeriodBookings: vi.fn(async () => null),
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

  /**
   * El próximo cobro se muestra en la zona horaria DEL NEGOCIO.
   *
   * Es una fecha sobre plata: el dueño la lee para saber cuándo le van a
   * descontar. Pintada en la zona del servidor, un negocio mexicano ve el día
   * que corresponde en Buenos Aires, y la diferencia se nota justo en el borde
   * del mes, que es cuando importa.
   *
   * La zona del PROCESO se fija a UTC a propósito. Sin eso, en una máquina que
   * ya corre en horario argentino el test pasaría con el bug puesto: estaría
   * probando dónde corre la suite, no que se use `tenant.timezone`.
   */
  describe("con el proceso en UTC y el negocio en Buenos Aires", () => {
    const tzOriginal = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "UTC";
    });
    afterAll(() => {
      process.env.TZ = tzOriginal;
    });

    it(
      "muestra el próximo cobro en la hora del negocio, no la del servidor",
      { timeout: 15000 },
      async () => {
        const { getCurrentSubscription } = await import(
          "@/modules/billing/application/queries"
        );
        // 02:00 UTC del 1 de septiembre son las 23:00 del 31 de agosto en
        // Buenos Aires: las dos lecturas caen en meses distintos.
        vi.mocked(getCurrentSubscription).mockResolvedValue(
          subscription({
            status: "active",
            currentPeriodEnd: new Date("2026-09-01T02:00:00.000Z"),
          }),
        );

        await renderPage();

        expect(screen.getByText(/31 de agosto/i)).toBeInTheDocument();
        expect(screen.queryByText(/1 de septiembre/i)).toBeNull();
      },
    );
  });

  /**
   * El techo de turnos del período.
   *
   * Es un freno ANTI-ABUSO, no una palanca de venta: está tan alto que un
   * negocio normal no lo toca. Por eso lo único que hace es AVISARLE AL DUEÑO
   * —que es quien eligió el plan— y NO bloquea a nadie que quiera reservar.
   *
   * Se cuenta por carga y no por fecha del turno; el porqué vive en
   * `bookingCeilingState` y en la migración.
   */
  describe("techo de turnos", () => {
    async function conTurnos(
      cargados: number | null,
      negocio: Tenant = tenant,
    ) {
      const { getCurrentSubscription, countPeriodBookings } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(subscription());
      vi.mocked(countPeriodBookings).mockResolvedValue(cargados);
      await renderPage({}, negocio);
    }

    /**
     * El aviso completo, como párrafo.
     *
     * No sirve `getByText`: la cantidad va en un `<b>`, así que "Cargaste",
     * "120" y "de 300 turnos" son tres nodos distintos y un matcher de texto
     * plano no cruza esa frontera. Lo que se afirma es la FRASE, no el nodo.
     */
    function ceilingNotice(): HTMLElement | null {
      return (
        [...document.querySelectorAll("p")].find((el) =>
          /turnos de tu plan/i.test(el.textContent ?? ""),
        ) ?? null
      );
    }

    it("dice cuántos turnos lleva cargados y cuántos permite el plan", { timeout: 15000 }, async () => {
      await conTurnos(120);

      // Básico son 300.
      expect(ceilingNotice()).toHaveTextContent(/Cargaste 120 de 300 turnos/);
    });

    it("avisa cuando queda poco margen", { timeout: 15000 }, async () => {
      await conTurnos(250);

      expect(ceilingNotice()).toHaveTextContent(/te queda poco margen/i);
    });

    it("al pasarse aclara que los clientes SIGUEN pudiendo reservar", { timeout: 15000 }, async () => {
      // Lo más importante de toda esta tajada. El dueño que ve "te pasaste"
      // asume que su agenda se cerró y sale a apagar un incendio que no
      // existe: el techo no bloquea ninguna reserva.
      await conTurnos(310);

      expect(ceilingNotice()).toHaveTextContent(/siguen pudiendo reservar/i);
    });

    it("cuando no se pudo contar NO muestra ningún número", { timeout: 15000 }, async () => {
      // `null` es "no sabemos", no cero. Pintar "0 de 300" acá le diría al
      // dueño que va tranquilo justo cuando no podemos afirmarlo.
      await conTurnos(null);

      expect(ceilingNotice()).toBeNull();
    });

    it("el techo es el del plan EFECTIVO, cortesía incluida", { timeout: 15000 }, async () => {
      // Un negocio con premium de regalo tiene el techo de premium. Usar el
      // plan pagado le avisaría a los 300 teniendo 5000 disponibles.
      await conTurnos(400, {
        ...tenant,
        plan: "premium",
        paid_plan: "basico",
        plan_courtesy: "premium",
      });

      expect(ceilingNotice()).toHaveTextContent(/Cargaste 400 de 5000 turnos/);
    });
  });
});
