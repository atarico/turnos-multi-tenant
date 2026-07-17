import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorState } from "@/core/action";
import { appError, err, ok } from "@/core/result";

import {
  createBookingAction,
  getAvailabilityAction,
  getSlotsAction,
  listStaffAction,
} from "../application/actions";
import type { AvailableSlot, BookableService, BookableStaff } from "../domain/types";
import { BookingFlow } from "./booking-flow";

/**
 * Characterization test for `BookingFlow` AS IT IS TODAY, written before the
 * planned `BookingActions` prop-injection refactor (p2 task 6.2). It mocks
 * `../application/actions` because the component currently imports the four
 * Server Actions directly (no prop seam yet). The refactor must keep every
 * assertion here green — it only changes WHERE these functions come from,
 * not their signatures or the component's behavior.
 */
vi.mock("../application/actions", () => ({
  listStaffAction: vi.fn(),
  getAvailabilityAction: vi.fn(),
  getSlotsAction: vi.fn(),
  createBookingAction: vi.fn(),
}));

const mockListStaff = vi.mocked(listStaffAction);
const mockGetAvailability = vi.mocked(getAvailabilityAction);
const mockGetSlots = vi.mocked(getSlotsAction);
const mockCreateBooking = vi.mocked(createBookingAction);

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

  render(<BookingFlow services={[service]} timezone={TIMEZONE} />);

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
    render(<BookingFlow services={[]} timezone={TIMEZONE} />);

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

    render(<BookingFlow services={[service]} timezone={TIMEZONE} />);

    expect(screen.getByText(/30 min\s*·\s*\$\s*5\.000/)).toBeInTheDocument();

    await user.click(screen.getByText("Corte"));

    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(mockListStaff).toHaveBeenCalledWith("s1");
  });

  it("surfaces the action's error message when staff fails to load", async () => {
    mockListStaff.mockResolvedValue(
      err(appError("staff_fetch_failed", "No pudimos cargar los profesionales.")),
    );
    const user = userEvent.setup({ delay: null });

    render(<BookingFlow services={[service]} timezone={TIMEZONE} />);
    await user.click(screen.getByText("Corte"));

    expect(
      await screen.findByText("No pudimos cargar los profesionales."),
    ).toBeInTheDocument();
  });

  it("shows a 'no availability' message and no calendar when the staff has no weekly windows", async () => {
    mockListStaff.mockResolvedValue(ok([staffMember]));
    mockGetAvailability.mockResolvedValue(ok({ weekdays: [], windows: [] }));
    const user = userEvent.setup({ delay: null });

    render(<BookingFlow services={[service]} timezone={TIMEZONE} />);
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

    render(<BookingFlow services={[service]} timezone={TIMEZONE} />);
    await user.click(screen.getByText("Corte"));
    await screen.findByText("Ana");

    await user.click(screen.getByRole("button", { name: "Volver" }));

    expect(screen.getByText("Elegí el servicio")).toBeInTheDocument();
    expect(screen.getByText("Corte")).toBeInTheDocument();
  });
});
