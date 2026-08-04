import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgendaBooking, BookingStatus } from "../domain/types";
import { BookingLifecycleActions } from "./booking-lifecycle-actions";

/**
 * La UI no puede ofrecer un cambio de estado que la Server Action va a
 * rechazar: los botones salen de la MISMA regla de dominio que valida el
 * servidor. Estos tests fijan esa correspondencia.
 */

vi.mock("../application/booking-lifecycle", () => ({
  updateBookingStatusAction: vi.fn(),
}));

const base: AgendaBooking = {
  id: "b1",
  customerName: "María González",
  customerPhone: null,
  serviceName: "Corte de pelo",
  staffName: "Ana Gómez",
  startsAt: "2026-07-23T14:30:00.000Z",
  endsAt: "2026-07-23T15:00:00.000Z",
  status: "confirmed",
};

const withStatus = (status: BookingStatus): AgendaBooking => ({ ...base, status });

describe("BookingLifecycleActions", () => {
  it("ofrece cerrar un turno confirmado en sus tres desenlaces", () => {
    render(<BookingLifecycleActions booking={withStatus("confirmed")} />);

    expect(screen.getByRole("button", { name: "Completar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No asistió" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("ofrece confirmar sólo cuando el turno está pendiente", () => {
    render(<BookingLifecycleActions booking={withStatus("pending")} />);
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
  });

  it("no ofrece confirmar un turno ya confirmado", () => {
    render(<BookingLifecycleActions booking={withStatus("confirmed")} />);
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("manda el estado destino en el value del botón apretado", () => {
    render(<BookingLifecycleActions booking={withStatus("confirmed")} />);

    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveAttribute(
      "value",
      "cancelled",
    );
    expect(screen.getByRole("button", { name: "Completar" })).toHaveAttribute(
      "value",
      "completed",
    );
  });

  it("deja reprogramar un turno vivo, apuntando a ese turno", () => {
    render(<BookingLifecycleActions booking={withStatus("confirmed")} />);

    expect(screen.getByRole("link", { name: /Reprogramar/ })).toHaveAttribute(
      "href",
      "/panel/turnos/b1/reprogramar",
    );
  });

  it.each<BookingStatus>(["cancelled", "completed", "no_show"])(
    "no renderiza ninguna acción para un turno %s",
    (status) => {
      const { container } = render(
        <BookingLifecycleActions booking={withStatus(status)} />,
      );

      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("link", { name: /Reprogramar/ })).toBeNull();
    },
  );
});
