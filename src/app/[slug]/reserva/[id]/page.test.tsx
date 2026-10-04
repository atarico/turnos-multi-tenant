import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { err, ok } from "@/core/result";
import { throwingNotFoundSpy } from "@/test-support/next-navigation";

/**
 * La página de retorno de Mercado Pago. Lo que se fija acá: el candado
 * (id Y negocio), un mensaje por estado, y que NADA de lo que traiga la URL
 * (query params de MP) llegue al HTML.
 */

const notFound = throwingNotFoundSpy();
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

vi.mock("@/modules/tenants/application/queries", () => ({ getTenantBySlug: vi.fn() }));
vi.mock("@/modules/payments/application/booking-return", () => ({
  getBookingForReturn: vi.fn(),
}));

const TENANT = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  timezone: "America/Argentina/Buenos_Aires",
  brandColor: "#e3b23c",
  logoUrl: null,
  takesBookings: true,
};
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: "pending",
    paymentStatus: "awaiting",
    paymentExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    serviceName: "Corte",
    // 13:00Z = 10:00 en Buenos Aires
    startsAt: "2026-10-05T13:00:00.000Z",
    ...overrides,
  };
}

async function arrange(
  loaded: ReturnType<typeof ok> | ReturnType<typeof err> | "no-tenant",
) {
  const { getTenantBySlug } = await import("@/modules/tenants/application/queries");
  const { getBookingForReturn } = await import("@/modules/payments/application/booking-return");
  vi.mocked(getTenantBySlug).mockResolvedValue(loaded === "no-tenant" ? null : TENANT);
  if (loaded !== "no-tenant") {
    vi.mocked(getBookingForReturn).mockResolvedValue(
      loaded as Awaited<ReturnType<typeof getBookingForReturn>>,
    );
  }
  return { getBookingForReturn: vi.mocked(getBookingForReturn) };
}

async function renderPage(props: Record<string, unknown> = {}) {
  const { default: Page } = await import("./page");
  render(await Page({ params: Promise.resolve({ slug: "acme", id: ID }), ...props } as never));
}

beforeEach(() => {
  vi.resetAllMocks();
});

// El primer `import("./page")` arrastra date-fns/es y el árbol de UI: en la suite
// completa, con todo corriendo en paralelo, pasa los 5s por defecto.
describe("página de retorno /[slug]/reserva/[id]", { timeout: 15000 }, () => {
  it("busca el turno por el negocio resuelto del slug y el id de la URL", async () => {
    const { getBookingForReturn } = await arrange(ok(booking()));

    await renderPage();

    expect(getBookingForReturn).toHaveBeenCalledWith("t1", ID);
  });

  it("un slug que no existe es 404", async () => {
    await arrange("no-tenant");
    await expect(renderPage()).rejects.toThrow();
    expect(notFound).toHaveBeenCalled();
  });

  it("un turno que no existe, o que es de otro negocio, es 404", async () => {
    await arrange(ok(null));
    await expect(renderPage()).rejects.toThrow();
    expect(notFound).toHaveBeenCalled();
  });

  it("esperando el pago: 'Estamos confirmando tu pago…' con un link para actualizar", async () => {
    await arrange(ok(booking()));

    await renderPage();

    expect(screen.getByText(/Estamos confirmando tu pago/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Actualizar" })).toHaveAttribute(
      "href",
      `/acme/reserva/${ID}`,
    );
  });

  it("confirmado: '¡Turno confirmado!'", async () => {
    await arrange(ok(booking({ status: "confirmed", paymentStatus: "paid", paymentExpiresAt: null })));

    await renderPage();

    expect(screen.getByText("¡Turno confirmado!")).toBeInTheDocument();
    expect(screen.queryByText(/Estamos confirmando/)).not.toBeInTheDocument();
  });

  it("cancelado: el pago no se completó, el turno se liberó, y hay link para volver a reservar", async () => {
    await arrange(ok(booking({ status: "cancelled" })));

    await renderPage();

    expect(
      screen.getByText("El pago no se completó y el turno se liberó."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /reservar de nuevo/i })).toHaveAttribute("href", "/acme");
  });

  it("un hold vencido se muestra como liberado, no como espera eterna", async () => {
    await arrange(ok(booking({ paymentExpiresAt: new Date(Date.now() - 60_000).toISOString() })));

    await renderPage();

    expect(screen.getByText(/el turno se liberó/)).toBeInTheDocument();
  });

  it("muestra servicio, día y hora EN LA ZONA DEL NEGOCIO, y el nombre del negocio", async () => {
    await arrange(ok(booking({ status: "confirmed", paymentStatus: "paid", paymentExpiresAt: null })));

    await renderPage();

    expect(screen.getByText("Corte")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    // 13:00Z son las 10:00 en Buenos Aires.
    expect(screen.getByText(/lunes 5 de octubre.*10:00/i)).toBeInTheDocument();
  });

  it("un error al consultar muestra un aviso con link para actualizar, no un 404", async () => {
    await arrange(err({ code: "booking_load_failed", message: "x" }));

    await renderPage();

    expect(screen.getByText(/No pudimos consultar tu turno/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Actualizar" })).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("NO repite en el HTML nada de lo que traiga la URL (query params de MP)", async () => {
    await arrange(ok(booking()));

    await renderPage({
      searchParams: Promise.resolve({
        status: "approved",
        payment_id: "999",
        collection_status: "approved",
        x: "<script>alert(1)</script>",
      }),
    });

    const html = document.body.innerHTML;
    expect(html).not.toContain("approved");
    expect(html).not.toContain("999");
    expect(html).not.toContain("script");
    // Y con 'approved' en la URL, igual sigue esperando: manda la base.
    expect(screen.getByText(/Estamos confirmando tu pago/)).toBeInTheDocument();
  });
});

describe("metadata", { timeout: 15000 }, () => {
  it("no se indexa", async () => {
    const { metadata } = await import("./page");
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});
