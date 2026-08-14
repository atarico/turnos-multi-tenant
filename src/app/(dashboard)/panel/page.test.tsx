import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgendaBooking } from "@/modules/booking/domain/types";
import { publicBookingUrl } from "@/modules/tenants/domain/public-url";
import type { Tenant } from "@/modules/tenants/domain/types";

// `redirect()` real corta el render lanzando: si el mock devolviera undefined
// la page seguiría ejecutándose con `tenant` en null y reventaría por otro lado.
const redirect = vi.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
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

/** El valor pintado en la tarjeta de métrica con esa etiqueta. */
function metricValue(label: string): string {
  const card = screen.getByText(label).closest("div")!.parentElement!;
  return card.querySelector("p")!.textContent!;
}

describe("PanelPage", () => {
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

  // "Turnos hoy" sale de su propia consulta contra la base, NO de filtrar la
  // lista de próximos turnos. Esa lista corta en `starts_at >= now()`: a las
  // 23:00 los turnos de las 23:00 ya no están ahí y el contador marcaba 0
  // mientras el día seguía teniendo dos turnos.
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
