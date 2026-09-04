import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicTenant } from "@/modules/tenants/domain/types";

vi.mock("@/modules/tenants/application/queries", () => ({
  getTenantBySlug: vi.fn(),
}));
vi.mock("@/modules/booking/application/public-queries", () => ({
  listPublicServices: vi.fn(async () => ({ ok: true, value: [] })),
}));
// El flujo público es un árbol de cliente entero. Acá sólo importa si está.
vi.mock("@/modules/booking/ui/public-booking-flow", () => ({
  PublicBookingFlow: () => <div data-testid="public-booking-flow" />,
}));
vi.mock("@/modules/booking/ui/public-header", () => ({
  PublicHeader: ({ name }: { name: string }) => <h1>{name}</h1>,
}));

function tenant(takesBookings: boolean): PublicTenant {
  return {
    id: "t1",
    slug: "acme",
    name: "Acme",
    timezone: "America/Argentina/Buenos_Aires",
    brandColor: "#e3b23c",
    logoUrl: null,
    takesBookings,
  };
}

async function renderPage() {
  const { default: PublicBookingPage } = await import("./page");
  render(await PublicBookingPage({ params: Promise.resolve({ slug: "acme" }) }));
}

describe("PublicBookingPage", () => {
  // `clearAllMocks` borra las llamadas pero NO la implementación que instaló
  // un `mockResolvedValue`: el stub que falla en el último caso se filtraba a
  // cualquier caso declarado después. Pasaba sólo por ser el último, y
  // reordenar rompía otro sin relación. `resetAllMocks` sí la saca; el default
  // se repone acá para que el archivo no dependa del orden.
  beforeEach(async () => {
    vi.resetAllMocks();

    const { listPublicServices } = await import(
      "@/modules/booking/application/public-queries"
    );
    vi.mocked(listPublicServices).mockResolvedValue({
      ok: true,
      value: [],
    } as Awaited<ReturnType<typeof listPublicServices>>);
  });

  it("un negocio al día muestra el flujo de reserva", { timeout: 15000 }, async () => {
    const { getTenantBySlug } = await import(
      "@/modules/tenants/application/queries"
    );
    vi.mocked(getTenantBySlug).mockResolvedValue(tenant(true));

    await renderPage();

    expect(screen.getByTestId("public-booking-flow")).toBeInTheDocument();
  });

  it(
    "un negocio que no toma reservas no muestra el flujo",
    { timeout: 15000 },
    async () => {
      const { getTenantBySlug } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getTenantBySlug).mockResolvedValue(tenant(false));

      await renderPage();

      expect(
        screen.queryByTestId("public-booking-flow"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/no está tomando reservas online/i),
      ).toBeInTheDocument();
    },
  );

  /**
   * NO es un 404 ni un error: el negocio existe, su marca se sigue viendo, y
   * quien llegó por su link tiene que poder seguir contactándolo. Un 404 le
   * diría al cliente del negocio que el negocio no existe, que es falso y
   * además le hace daño al negocio.
   */
  it(
    "el negocio cerrado sigue mostrando su nombre y un camino de contacto",
    { timeout: 15000 },
    async () => {
      const { getTenantBySlug } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getTenantBySlug).mockResolvedValue(tenant(false));

      await renderPage();

      expect(screen.getByRole("heading", { name: "Acme" })).toBeInTheDocument();
      expect(screen.getByText(/escribiles o llamalos/i)).toBeInTheDocument();
    },
  );

  /**
   * Que al negocio se le haya vencido la prueba, que deba o que haya cancelado
   * es información SUYA. La vista `public_tenants` expone un booleano
   * justamente para no filtrarla; contarlo en la pantalla sería entregar por
   * la puerta de adelante lo mismo que la base protege.
   */
  it.each(["prueba", "plan", "venci", "pag", "suscrip", "deud"])(
    "la pantalla del negocio cerrado no menciona %s",
    async (leak) => {
      const { getTenantBySlug } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getTenantBySlug).mockResolvedValue(tenant(false));

      await renderPage();

      expect(document.body.textContent?.toLowerCase()).not.toContain(leak);
    },
  );

  /**
   * Y no se le pide al visitante que espere a que un servicio falle para
   * enterarse: el aviso gana sobre el error del catálogo, porque el catálogo
   * no es el problema.
   */
  it(
    "el aviso gana sobre un error del catálogo",
    { timeout: 15000 },
    async () => {
      const { getTenantBySlug } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listPublicServices } = await import(
        "@/modules/booking/application/public-queries"
      );
      vi.mocked(getTenantBySlug).mockResolvedValue(tenant(false));
      vi.mocked(listPublicServices).mockResolvedValue({
        ok: false,
        error: { message: "No pudimos cargar los servicios." },
      } as Awaited<ReturnType<typeof listPublicServices>>);

      await renderPage();

      expect(
        screen.getByText(/no está tomando reservas online/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("No pudimos cargar los servicios."),
      ).not.toBeInTheDocument();
    },
  );
});
