import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgendaBooking } from "../domain/types";
import { AgendaList } from "./agenda-list";

vi.mock("../application/booking-lifecycle", () => ({
  updateBookingStatusAction: vi.fn(),
}));

const TIMEZONE = "America/Argentina/Buenos_Aires";

const booking: AgendaBooking = {
  id: "b1",
  customerName: "María González",
  customerPhone: null,
  serviceName: "Corte de pelo",
  staffName: "Ana Gómez",
  // 14:30 UTC → 11:30 en Buenos Aires (UTC-3): fija la conversión de timezone.
  startsAt: "2026-07-23T14:30:00.000Z",
  endsAt: "2026-07-23T15:00:00.000Z",
  status: "confirmed",
};

describe("AgendaList", () => {
  it("shows an empty state when there are no upcoming bookings", () => {
    render(<AgendaList bookings={[]} timezone={TIMEZONE} />);

    expect(
      screen.getByText(/Todavía no tenés turnos próximos/),
    ).toBeInTheDocument();
  });

  it("renders a booking with customer, service, staff, local time and status badge", () => {
    render(<AgendaList bookings={[booking]} timezone={TIMEZONE} />);

    expect(screen.getByText("María González")).toBeInTheDocument();
    expect(screen.getByText("Corte de pelo · Ana Gómez")).toBeInTheDocument();
    // La hora se muestra en la tz del negocio, no en UTC.
    expect(screen.getByText("11:30")).toBeInTheDocument();
    expect(screen.getByText("Confirmado")).toBeInTheDocument();
  });

  // La lista se usa para dos cosas distintas (próximos turnos y turnos a
  // cerrar), y el vacío tiene que decir algo distinto en cada caso.
  it("uses the caller's empty message when given one", () => {
    render(
      <AgendaList bookings={[]} timezone={TIMEZONE} emptyMessage="Nada que cerrar." />,
    );

    expect(screen.getByText("Nada que cerrar.")).toBeInTheDocument();
  });

  it("stays read-only by default: no lifecycle actions", () => {
    render(<AgendaList bookings={[booking]} timezone={TIMEZONE} />);

    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  it("renders the lifecycle actions when asked to", () => {
    render(<AgendaList bookings={[booking]} timezone={TIMEZONE} withActions />);

    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reprogramar/ })).toBeInTheDocument();
  });
});
