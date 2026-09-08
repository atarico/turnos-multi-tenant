import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Subscription } from "@/modules/billing/domain/subscription";
import type { Tenant } from "@/modules/tenants/domain/types";

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/booking/application/queries", () => ({
  listServices: vi.fn(async () => ({ ok: true, value: [] })),
}));
vi.mock("@/modules/billing/application/queries", () => ({
  getCurrentSubscription: vi.fn(),
}));
// Las actions arrastrarían el cliente de Supabase al importarse: acá sólo
// importa lo que la pantalla pinta.
vi.mock("@/modules/booking/application/actions", () => ({
  createBookingAction: vi.fn(),
  getAvailabilityAction: vi.fn(),
  getSlotsAction: vi.fn(),
  listStaffAction: vi.fn(),
}));
// El flujo de reserva es un árbol de cliente entero. Lo único que este archivo
// necesita saber es si está o no está.
vi.mock("@/modules/booking/ui/booking-flow", () => ({
  BookingFlow: () => <div data-testid="booking-flow" />,
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

/**
 * Una suscripción con la fecha de prueba movida contra el reloj REAL, no
 * contra una constante: la pantalla llama a `new Date()` adentro, así que
 * anclar la fecha a un día fijo haría que estos casos se dieran vuelta solos
 * cuando ese día pase.
 */
function subscription(
  status: Subscription["status"],
  trialEndsInDays: number | null,
): Subscription {
  const trialEndsAt =
    trialEndsInDays === null
      ? null
      : new Date(Date.now() + trialEndsInDays * 24 * 60 * 60 * 1000);

  return {
    id: "s1",
    tenantId: "t1",
    plan: "basico",
    status,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(),
    trialEndsAt,
    priceUsdCents: 0,
    chargedAmountCents: null,
    chargedCurrency: "ARS",
    fxRate: null,
    fxSource: null,
    fxQuotedAt: null,
  };
}

async function renderPage() {
  const { default: NuevaReservaPage } = await import("./page");
  render(await NuevaReservaPage());
}

describe("NuevaReservaPage", () => {
  beforeEach(async () => {
    const { getCurrentTenant } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
  });

  it(
    "con la prueba vigente se puede cargar un turno",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        subscription("trialing", 5),
      );

      await renderPage();

      expect(screen.getByTestId("booking-flow")).toBeInTheDocument();
    },
  );

  /**
   * EL caso. La prueba venció y el estado SIGUE en `trialing`, porque nada lo
   * mueve. Si la pantalla mirara el estado en vez de la fecha, acá mostraría
   * el formulario.
   */
  it(
    "con la prueba vencida no se puede cargar un turno",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        subscription("trialing", -1),
      );

      await renderPage();

      expect(screen.queryByTestId("booking-flow")).not.toBeInTheDocument();
      expect(screen.getByText(/no entran turnos nuevos/i)).toBeInTheDocument();
    },
  );

  /**
   * Lo primero que piensa alguien que no puede cargar un turno es que perdió
   * la agenda. El aviso tiene que decir que NO, y llevarlo a donde se
   * resuelve: un cartel que sólo diga "no podés" deja a un dueño buscando el
   * botón de pagar.
   */
  it(
    "el aviso aclara que la agenda quedó intacta y lleva a pagar",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        subscription("trialing", -1),
      );

      await renderPage();

      expect(screen.getByText(/agenda no se tocó/i)).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /elegir un plan/i }),
      ).toHaveAttribute("href", "/panel/suscripcion");
    },
  );

  it(
    "una suscripción paga carga turnos aunque la fecha de prueba haya pasado",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        subscription("active", -30),
      );

      await renderPage();

      expect(screen.getByTestId("booking-flow")).toBeInTheDocument();
    },
  );

  it(
    "un cobro atrasado sigue cargando turnos durante la gracia",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        subscription("past_due", null),
      );

      await renderPage();

      expect(screen.getByTestId("booking-flow")).toBeInTheDocument();
    },
  );

  /**
   * `getCurrentSubscription` contesta `null` tanto si no hay suscripción como
   * si la base no contestó, y la pantalla NO puede distinguirlas. Ante la duda
   * muestra el formulario: acusar de vencido a un dueño que está al día es el
   * error caro, y el freno de verdad —`create_booking()`— sigue estando ahí
   * para rechazar la reserva si de verdad corresponde.
   */
  it(
    "ante una lectura que no contesta muestra el formulario, no el aviso",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(null);

      await renderPage();

      expect(screen.getByTestId("booking-flow")).toBeInTheDocument();
      expect(
        screen.queryByText(/no entran turnos nuevos/i),
      ).not.toBeInTheDocument();
    },
  );

  // La prueba vencida es UNA de las tres causas —también la cancelada y la
  // ausencia de suscripción—: a quien canceló, hablarle de una prueba le
  // describe algo que no pasó.
  it(
    "el aviso no le atribuye el bloqueo a la prueba",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      vi.mocked(getCurrentSubscription).mockResolvedValue(
        subscription("trialing", -1),
      );

      await renderPage();

      expect(document.body.textContent?.toLowerCase()).not.toContain("prueba");
    },
  );

  // HUECO CONOCIDO, fijado a propósito: una cancelada llega como `null`, es
  // indistinguible de una lectura fallida, y el dueño se entera al enviar. El
  // día que alguien lo cierre, este caso le dice qué conducta cambia.
  it(
    "una suscripción cancelada llega como null y todavía muestra el formulario",
    { timeout: 15000 },
    async () => {
      const { getCurrentSubscription } = await import(
        "@/modules/billing/application/queries"
      );
      // Lo que devuelve de verdad para un negocio cancelado: null, no la fila.
      vi.mocked(getCurrentSubscription).mockResolvedValue(null);

      await renderPage();

      expect(screen.getByTestId("booking-flow")).toBeInTheDocument();
    },
  );
});
