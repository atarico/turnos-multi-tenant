import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgendaBooking } from "../domain/types";
import { AgendaList } from "./agenda-list";

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
});
