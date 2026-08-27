import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { throwingRedirectSpy } from "@/test-support/next-navigation";
import type { Subscription } from "@/modules/billing/domain/subscription";
import type { AgendaBooking } from "@/modules/booking/domain/types";
import { publicBookingUrl } from "@/modules/tenants/domain/public-url";
import type { Tenant } from "@/modules/tenants/domain/types";

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/booking/application/queries", () => ({
  listUpcomingBookings: vi.fn(async () => ({ ok: true, value: [] })),
  listBookingsToClose: vi.fn(async () => ({ ok: true, value: [] })),
  countBookingsOnDay: vi.fn(async () => ({ ok: true, value: 0 })),
  sumMonthlyRevenue: vi.fn(async () => ({
    ok: true,
    value: { totalCents: 0, currency: "ARS" },
  })),
}));
// Por defecto, un negocio sin suscripción: el panel tiene que pintarse igual.
vi.mock("@/modules/billing/application/queries", () => ({
  getCurrentSubscription: vi.fn(async () => null),
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

const HOUR = 3_600_000;
const fromNow = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const agendaBooking = (
  id: string,
  offsetMs: number,
): AgendaBooking => ({
  id,
  customerName: `Cliente ${id}`,
  customerPhone: null,
  serviceName: "Corte",
  staffName: "Ana",
  startsAt: fromNow(offsetMs),
  endsAt: fromNow(offsetMs + HOUR),
  status: "confirmed",
});

/** Una suscripción en prueba que vence dentro de `offsetMs` desde ahora. */
const trialSubscription = (offsetMs: number): Subscription => ({
  id: "sub-1",
  tenantId: tenant.id,
  plan: "basico",
  status: "trialing",
  currentPeriodStart: new Date(Date.now() - HOUR),
  currentPeriodEnd: new Date(Date.now() + offsetMs),
  trialEndsAt: new Date(Date.now() + offsetMs),
  priceUsdCents: 0,
  chargedAmountCents: null,
  chargedCurrency: "ARS",
  fxRate: null,
  fxSource: null,
  fxQuotedAt: null,
});

/** El valor pintado en la tarjeta de métrica con esa etiqueta. */
function metricValue(label: string): string {
  const card = screen.getByText(label).closest("div")!.parentElement!;
  return card.querySelector("p")!.textContent!;
}

describe("PanelPage", () => {
  // Mismo timeout ampliado que sus vecinos: bajo contención de CPU en la
  // suite completa este test mide ~6.7s y el default de 5000ms flakea.
  it("deja llegar a la suscripción desde el plan", { timeout: 15000 }, async () => {
    // Sin este link la pantalla de suscripción existe y no la encuentra nadie:
    // el dueño no tiene forma de contratar un plan.
    const { getCurrentTenant } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
    const { default: PanelPage } = await import("./page");

    render(await PanelPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("link", { name: /ver tu suscripción/i }),
    ).toHaveAttribute("href", "/panel/suscripcion");
  });

  it(
    "manda a la bienvenida cuando la cuenta todavía no tiene negocio",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(null);
      const { default: PanelPage } = await import("./page");

      await expect(
        PanelPage({ searchParams: Promise.resolve({}) }),
      ).rejects.toThrow("NEXT_REDIRECT:/panel/bienvenida");
      expect(redirect).toHaveBeenCalledWith("/panel/bienvenida");
    },
  );

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

  /**
   * El dueño tiene que saber cuánto le queda de prueba SIN ir a buscarlo. Es
   * la única señal de que el reloj está corriendo, y aparece al lado del plan
   * porque son la misma pregunta: qué tengo y hasta cuándo.
   */
  it(
    "avisa cuántos días de prueba quedan",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        trialSubscription(6 * 24 * HOUR),
      );
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByText(/prueba · 6 días/i)).toBeInTheDocument();
    },
  );

  // Sin prueba corriendo no se pinta nada: un cartel de prueba en una cuenta
  // paga confundiría más de lo que informa.
  it(
    "no muestra el cartel de prueba cuando la prueba venció",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        trialSubscription(-HOUR),
      );
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      expect(screen.queryByText(/prueba ·/i)).not.toBeInTheDocument();
    },
  );

  // El link es lo que el dueño manda a sus clientes: tiene que poder copiarlo
  // desde el panel, no seleccionarlo a mano.
  it(
    "ofrece copiar el link público desde el panel",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      process.env.NEXT_PUBLIC_APP_URL = "https://turnos.app";
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      expect(
        screen.getByRole("button", { name: "Copiar enlace" }),
      ).toBeInTheDocument();
    },
  );

  it(
    "labels the public booking link so the tenant knows what the URL is for",
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

      expect(screen.getByText(/URL para clientes/i)).toBeInTheDocument();
    },
  );

  // Las dos listas del panel comparten `withActions`, pero no comparten
  // momento: "Turnos a cerrar" son turnos que ya pasaron y "Próximos turnos"
  // son turnos que no. Cerrar sólo tiene sentido en la primera; cancelar, en
  // las dos — por eso la de próximos conserva sus acciones.
  it(
    "ofrece cerrar los turnos vencidos y sólo cancelar los próximos",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listBookingsToClose, listUpcomingBookings } = await import(
        "@/modules/booking/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(listBookingsToClose).mockResolvedValueOnce({
        ok: true,
        value: [agendaBooking("vencido", -2 * HOUR)],
      });
      vi.mocked(listUpcomingBookings).mockResolvedValueOnce({
        ok: true,
        value: [agendaBooking("proximo", HOUR)],
      });
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByText("Turnos a cerrar")).toBeInTheDocument();
      expect(
        screen.getAllByRole("button", { name: "Completar" }),
      ).toHaveLength(1);
      expect(
        screen.getAllByRole("button", { name: "No asistió" }),
      ).toHaveLength(1);
      // Una por lista: la acción que vale para un turno futuro sigue estando.
      expect(screen.getAllByRole("button", { name: "Cancelar" })).toHaveLength(2);
    },
  );

  // Las dos listas son una sola agenda partida en dos por el mismo instante. Si
  // cada consulta leyera su propio reloj, un turno que termina entre las dos
  // lecturas cumpliría los dos filtros y saldría duplicado en pantalla. La
  // página lee el reloj UNA vez y les pasa el mismo `Date` a las dos: por eso
  // acá se compara identidad de objeto y no igualdad de valor.
  it(
    "corta las dos listas con una única lectura del reloj",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listBookingsToClose, listUpcomingBookings } = await import(
        "@/modules/booking/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      const upcomingAt = vi.mocked(listUpcomingBookings).mock.calls[0]![1];
      const toCloseAt = vi.mocked(listBookingsToClose).mock.calls[0]![1];
      expect(upcomingAt).toBeInstanceOf(Date);
      expect(upcomingAt).toBe(toCloseAt);
    },
  );

  // "Turnos hoy" sale de su propia consulta contra la base, NO de filtrar la
  // lista de próximos turnos. Esa lista corta por `ends_at`: los turnos del día
  // que ya terminaron no están ahí, y el contador marcaba 0 mientras el día
  // seguía teniendo dos turnos.
  it(
    "cuenta los turnos del día aunque ya no queden próximos turnos",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { countBookingsOnDay, listUpcomingBookings } = await import(
        "@/modules/booking/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(listUpcomingBookings).mockResolvedValueOnce({
        ok: true,
        value: [],
      });
      vi.mocked(countBookingsOnDay).mockResolvedValueOnce({ ok: true, value: 2 });
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      expect(metricValue("Turnos hoy")).toBe("2");
      expect(countBookingsOnDay).toHaveBeenCalledWith(
        tenant.id,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        tenant.timezone,
      );
    },
  );

  // Un cero es un dato. Si la consulta falla, decir "0 turnos hoy" es mentirle
  // al dueño sobre su propio día: mejor admitir que no se pudo leer.
  it(
    "muestra — en vez de 0 cuando el conteo del día falla",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { countBookingsOnDay } = await import(
        "@/modules/booking/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(countBookingsOnDay).mockResolvedValueOnce({
        ok: false,
        error: { code: "bookings_count_failed", message: "boom" },
      });
      const { default: PanelPage } = await import("./page");

      render(await PanelPage({ searchParams: Promise.resolve({}) }));

      expect(metricValue("Turnos hoy")).toBe("—");
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
