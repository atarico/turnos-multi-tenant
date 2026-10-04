import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorState } from "@/core/action";
import { appError, err, ok } from "@/core/result";
import { formatPrice } from "@/modules/catalog/domain/money";

import type { AvailableSlot, BookableService, BookableStaff } from "../domain/types";
import { BookingFlow, type BookingActions } from "./booking-flow";

/**
 * Behavioral test for `BookingFlow`. The four data operations are injected via
 * the `actions` prop (`BookingActions` seam, p2 task 6.2), so the component is
 * exercised the same way the panel and the public page drive it — without
 * knowing where tenant resolution happens. These are the characterization
 * assertions kept green through the prop-injection refactor: only WHERE the
 * functions come from changed, not their signatures or the component's behavior.
 */
const mockListStaff = vi.fn<BookingActions["listStaff"]>();
const mockGetAvailability = vi.fn<BookingActions["getAvailability"]>();
const mockGetSlots = vi.fn<BookingActions["getSlots"]>();
const mockCreateBooking = vi.fn<BookingActions["createBooking"]>();

const actions: BookingActions = {
  listStaff: mockListStaff,
  getAvailability: mockGetAvailability,
  getSlots: mockGetSlots,
  createBooking: mockCreateBooking,
};

const TIMEZONE = "America/Argentina/Buenos_Aires";

const service: BookableService = {
  id: "s1",
  name: "Corte",
  description: null,
  durationMin: 30,
  priceCents: 500000,
  currency: "ARS",
  capacity: 1,
};

const staffMember: BookableStaff = {
  id: "st1",
  name: "Ana",
  role: null,
  avatarUrl: null,
};

const slotAvailable: AvailableSlot = {
  startsAt: "2026-07-20T13:00:00.000Z",
  endsAt: "2026-07-20T13:30:00.000Z",
  label: "10:00",
  available: true,
  remaining: 1,
};

const slotFull: AvailableSlot = {
  startsAt: "2026-07-20T13:30:00.000Z",
  endsAt: "2026-07-20T14:00:00.000Z",
  label: "10:30",
  available: false,
  remaining: 0,
};

beforeEach(() => {
  // Frozen at a Monday so "today" in the calendar is deterministic and,
  // combined with weekdays: [1] below, lands on an enabled, clickable day
  // regardless of which real-world date the suite runs on.
  vi.setSystemTime(new Date(2026, 6, 20, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Drives the flow from step "service" to step "customer" via real user interactions. */
async function advanceToCustomerStep(user: ReturnType<typeof userEvent.setup>) {
  mockListStaff.mockResolvedValue(ok([staffMember]));
  mockGetAvailability.mockResolvedValue(ok({ weekdays: [1], windows: [] }));
  mockGetSlots.mockResolvedValue(ok([slotAvailable, slotFull]));

  render(<BookingFlow services={[service]} timezone={TIMEZONE} actions={actions} />);

  await user.click(screen.getByText("Corte"));
  await user.click(await screen.findByText("Ana"));

  const todayButton = await screen.findByRole("button", { name: /^Today/ });
  await user.click(todayButton);

  const slotButton = await screen.findByRole("button", { name: "10:00" });
  await user.click(slotButton);

  await screen.findByText("Datos del cliente");
}

describe("BookingFlow", () => {
  it("shows an empty-state message when there are no active services", () => {
    render(<BookingFlow services={[]} timezone={TIMEZONE} actions={actions} />);

    expect(
      screen.getByText(
        "Todavía no tenés servicios activos. Creá uno para poder reservar.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Corte/ })).not.toBeInTheDocument();
  });

  it("lists services with formatted duration and price, and fetches staff for the chosen one", async () => {
    mockListStaff.mockResolvedValue(ok([staffMember]));
    mockGetAvailability.mockResolvedValue(ok({ weekdays: [], windows: [] }));
    const user = userEvent.setup({ delay: null });

    render(<BookingFlow services={[service]} timezone={TIMEZONE} actions={actions} />);

    expect(screen.getByText("30 min · $ 5.000,00")).toBeInTheDocument();

    await user.click(screen.getByText("Corte"));

    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(mockListStaff).toHaveBeenCalledWith("s1");
  });

  it("shows the cents of a price instead of rounding them away", () => {
    // $5.000,50 le tiene que llegar al cliente con sus centavos: redondear el
    // precio que se muestra en la página pública es mostrarle otro número.
    const withCents: BookableService = { ...service, priceCents: 500050 };

    render(<BookingFlow services={[withCents]} timezone={TIMEZONE} actions={actions} />);

    expect(screen.getByText("30 min · $ 5.000,50")).toBeInTheDocument();
  });

  it("formats the price the same way the panel does", () => {
    // Una sola fuente de verdad para el dinero: lo que ve quien reserva y lo
    // que ve el negocio en el panel salen de la misma función.
    const withCents: BookableService = { ...service, priceCents: 500050 };

    render(<BookingFlow services={[withCents]} timezone={TIMEZONE} actions={actions} />);

    expect(
      screen.getByText(`30 min · ${formatPrice(500050, "ARS")}`),
    ).toBeInTheDocument();
  });

  it("surfaces the action's error message when staff fails to load", async () => {
    mockListStaff.mockResolvedValue(
      err(appError("staff_fetch_failed", "No pudimos cargar los profesionales.")),
    );
    const user = userEvent.setup({ delay: null });

    render(<BookingFlow services={[service]} timezone={TIMEZONE} actions={actions} />);
    await user.click(screen.getByText("Corte"));

    expect(
      await screen.findByText("No pudimos cargar los profesionales."),
    ).toBeInTheDocument();
  });

  it("shows a 'no availability' message and no calendar when the staff has no weekly windows", async () => {
    mockListStaff.mockResolvedValue(ok([staffMember]));
    mockGetAvailability.mockResolvedValue(ok({ weekdays: [], windows: [] }));
    const user = userEvent.setup({ delay: null });

    render(<BookingFlow services={[service]} timezone={TIMEZONE} actions={actions} />);
    await user.click(screen.getByText("Corte"));
    await user.click(await screen.findByText("Ana"));

    expect(
      await screen.findByText("Este profesional no tiene disponibilidad cargada."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(mockGetAvailability).toHaveBeenCalledWith("st1");
  });

  it("completes the full booking flow and calls createBookingAction with the selected slot and customer data", async () => {
    const user = userEvent.setup({ delay: null });
    await advanceToCustomerStep(user);

    expect(mockGetSlots).toHaveBeenCalledWith("s1", "st1", "2026-07-20");

    await user.type(screen.getByLabelText("Nombre del cliente"), "María González");

    mockCreateBooking.mockResolvedValue({
      status: "success",
      message: "Reserva confirmada.",
    });

    await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));

    expect(await screen.findByText("Reserva confirmada")).toBeInTheDocument();
    expect(
      screen.getByText("El turno de María González quedó registrado."),
    ).toBeInTheDocument();
    expect(mockCreateBooking).toHaveBeenCalledWith({
      service_id: "s1",
      staff_id: "st1",
      starts_at: "2026-07-20T13:00:00.000Z",
      customer_name: "María González",
      customer_email: "",
      customer_phone: "",
    });
  });

  it("blocks submission and shows a field error when the customer name is missing", async () => {
    const user = userEvent.setup({ delay: null });
    await advanceToCustomerStep(user);

    await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));

    expect(
      await screen.findByText("Ingresá el nombre del cliente"),
    ).toBeInTheDocument();
    expect(mockCreateBooking).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeInTheDocument();
  });

  it("surfaces the server error and stays on the customer step when confirmation fails", async () => {
    const user = userEvent.setup({ delay: null });
    await advanceToCustomerStep(user);

    await user.type(screen.getByLabelText("Nombre del cliente"), "María González");
    mockCreateBooking.mockResolvedValue(
      errorState("Ese horario ya no está disponible.", {
        starts_at: "Elegí otra franja.",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));

    expect(
      await screen.findByText("Ese horario ya no está disponible."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reserva confirmada")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirmar reserva" }),
    ).toBeInTheDocument();
  });

  it("lets the user go back a step without discarding the service list", async () => {
    mockListStaff.mockResolvedValue(ok([staffMember]));
    const user = userEvent.setup({ delay: null });

    render(<BookingFlow services={[service]} timezone={TIMEZONE} actions={actions} />);
    await user.click(screen.getByText("Corte"));
    await screen.findByText("Ana");

    await user.click(screen.getByRole("button", { name: "Volver" }));

    expect(screen.getByText("Elegí el servicio")).toBeInTheDocument();
    expect(screen.getByText("Corte")).toBeInTheDocument();
  });

  describe("reserva con pago", () => {
    const payService: BookableService = { ...service, payAtBooking: true };
    const MP_URL = "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=p1";
    const assign = vi.fn();

    beforeEach(() => {
      assign.mockClear();
      vi.stubGlobal("location", { ...window.location, assign });
    });
    afterEach(() => vi.unstubAllGlobals());

    async function advanceWith(
      user: ReturnType<typeof userEvent.setup>,
      services: BookableService[],
    ) {
      mockListStaff.mockResolvedValue(ok([staffMember]));
      mockGetAvailability.mockResolvedValue(ok({ weekdays: [1], windows: [] }));
      mockGetSlots.mockResolvedValue(ok([slotAvailable, slotFull]));
      render(<BookingFlow services={services} timezone={TIMEZONE} actions={actions} />);
      await user.click(screen.getByText("Corte"));
      await user.click(await screen.findByText("Ana"));
      await user.click(await screen.findByRole("button", { name: /^Today/ }));
      await user.click(await screen.findByRole("button", { name: "10:00" }));
      await screen.findByText("Datos del cliente");
      await user.type(screen.getByLabelText("Nombre del cliente"), "María González");
    }

    it("avisa en el resumen que se paga al reservar, con el monto", async () => {
      const user = userEvent.setup({ delay: null });
      await advanceWith(user, [payService]);

      expect(
        screen.getByText(`Se paga al reservar: ${formatPrice(500000, "ARS")}`),
      ).toBeInTheDocument();
    });

    it("no muestra el aviso cuando el servicio no exige pago", async () => {
      const user = userEvent.setup({ delay: null });
      await advanceWith(user, [service]);

      expect(screen.queryByText(/Se paga al reservar/)).not.toBeInTheDocument();
    });

    it("con el estado redirect va a Mercado Pago y muestra el aviso de traslado", async () => {
      mockCreateBooking.mockResolvedValue({ status: "redirect", url: MP_URL });
      const user = userEvent.setup({ delay: null });
      await advanceWith(user, [payService]);

      await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));

      expect(await screen.findByText("Te llevamos a Mercado Pago para pagar")).toBeInTheDocument();
      expect(assign).toHaveBeenCalledExactlyOnceWith(MP_URL);
      // Todavía no está confirmado: no se anuncia una reserva confirmada.
      expect(screen.queryByText("Reserva confirmada")).not.toBeInTheDocument();
    });

    it.each([
      ["http", "http://www.mercadopago.com.ar/checkout"],
      ["un dominio ajeno", "https://evil.example/checkout"],
      ["javascript:", "javascript:alert(1)"],
    ])("NO navega a una URL con %s: muestra un error y sigue en el formulario", async (_l, url) => {
      mockCreateBooking.mockResolvedValue({ status: "redirect", url });
      const user = userEvent.setup({ delay: null });
      await advanceWith(user, [payService]);

      await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));

      expect(await screen.findByText(/No pudimos abrir Mercado Pago/)).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
      expect(screen.queryByText("Te llevamos a Mercado Pago para pagar")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Confirmar reserva" })).toBeInTheDocument();
    });

    it("el error de reintento deja el formulario para volver a intentar", async () => {
      mockCreateBooking.mockResolvedValue(errorState("No pudimos iniciar el pago, probá de nuevo."));
      const user = userEvent.setup({ delay: null });
      await advanceWith(user, [payService]);

      await user.click(screen.getByRole("button", { name: "Confirmar reserva" }));

      expect(await screen.findByText("No pudimos iniciar el pago, probá de nuevo.")).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
    });
  });
});
