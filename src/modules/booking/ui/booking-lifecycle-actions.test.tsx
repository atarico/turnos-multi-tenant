import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgendaBooking, BookingStatus } from "../domain/types";
import { BookingLifecycleActions } from "./booking-lifecycle-actions";

/**
 * La UI no puede ofrecer un cambio de estado que la Server Action va a
 * rechazar: los botones salen de la MISMA regla de dominio que valida el
 * servidor. Estos tests fijan esa correspondencia.
 */

const cancelPaidBookingAction = vi.fn();
vi.mock("../application/booking-lifecycle", () => ({
  updateBookingStatusAction: vi.fn(),
  cancelPaidBookingAction: (...args: unknown[]) => cancelPaidBookingAction(...args),
}));

const HOUR = 3_600_000;
/** Instante relativo al reloj real: los fixtures no caducan con el calendario. */
const fromNow = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** El turno base YA TERMINÓ: es el único sobre el que se puede ofrecer cerrar. */
const base: AgendaBooking = {
  id: "b1",
  customerName: "María González",
  customerPhone: null,
  serviceName: "Corte de pelo",
  staffName: "Ana Gómez",
  startsAt: fromNow(-2 * HOUR),
  endsAt: fromNow(-HOUR),
  status: "confirmed",
  paymentStatus: "not_required",
  priceCents: 5000,
  currency: "ARS",
};

const withStatus = (status: BookingStatus): AgendaBooking => ({ ...base, status });

/** El mismo turno, todavía por delante. */
const upcoming = (status: BookingStatus = "confirmed"): AgendaBooking => ({
  ...withStatus(status),
  startsAt: fromNow(HOUR),
  endsAt: fromNow(2 * HOUR),
});

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

  // Un turno que todavía no pasó no se puede "completar": no hay nada que
  // contar todavía. El botón directamente no existe, así el dueño no lo aprieta
  // por error de un turno de la semana que viene.
  it("no ofrece cerrar un turno que todavía no ocurrió", () => {
    render(<BookingLifecycleActions booking={upcoming()} />);

    expect(screen.queryByRole("button", { name: "Completar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "No asistió" })).toBeNull();
  });

  // Y sin embargo la fila NO queda muda: cancelar un turno futuro (el cliente
  // avisa que no viene) y confirmarlo son el uso normal de la lista de próximos.
  it("sigue ofreciendo cancelar y reprogramar un turno futuro", () => {
    render(<BookingLifecycleActions booking={upcoming()} />);

    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reprogramar/ })).toBeInTheDocument();
  });

  it("sigue ofreciendo confirmar un turno futuro pendiente", () => {
    render(<BookingLifecycleActions booking={upcoming("pending")} />);

    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Completar" })).toBeNull();
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

/**
 * Cancelar un turno PAGADO no es un submit directo: primero se ofrece
 * reprogramar (la plata queda donde está), y sólo "Cancelar igual" dispara la
 * cancelación con devolución pendiente.
 */
describe("BookingLifecycleActions con un turno pagado", () => {
  const paid = (): AgendaBooking => ({
    ...upcoming("confirmed"),
    paymentStatus: "paid",
    priceCents: 150000,
    currency: "ARS",
  });

  it("no ofrece el paso hasta que se aprieta Cancelar", () => {
    render(<BookingLifecycleActions booking={paid()} />);

    expect(screen.queryByText(/¿Lo reprogramás en vez de cancelarlo\?/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar igual" })).toBeNull();
  });

  it("Cancelar no es un submit del cambio de estado: abre el paso de reprogramar", async () => {
    render(<BookingLifecycleActions booking={paid()} />);

    const cancel = screen.getByRole("button", { name: "Cancelar" });
    expect(cancel).toHaveAttribute("type", "button");
    await userEvent.click(cancel);

    expect(
      screen.getByText(/Este turno está pagado \(\$ 1\.500,00\)\. ¿Lo reprogramás en vez de cancelarlo\?/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Reprogramar/ }).at(-1)).toHaveAttribute(
      "href",
      "/panel/turnos/b1/reprogramar",
    );
    expect(screen.getByRole("button", { name: "Cancelar igual" })).toBeInTheDocument();
  });

  it("Cancelar igual manda el id del turno a cancelPaidBookingAction", async () => {
    cancelPaidBookingAction.mockResolvedValue({ status: "success", message: "ok" });
    render(<BookingLifecycleActions booking={paid()} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar igual" }));

    await waitFor(() => expect(cancelPaidBookingAction).toHaveBeenCalled());
    const form = cancelPaidBookingAction.mock.calls[0]![1] as FormData;
    expect(form.get("id")).toBe("b1");
  });

  it("después de cancelar avisa que la devolución se hace desde Mercado Pago", async () => {
    cancelPaidBookingAction.mockResolvedValue({
      status: "success",
      message: "Turno cancelado. Devolvele el pago a tu cliente desde tu cuenta de Mercado Pago.",
    });
    render(<BookingLifecycleActions booking={paid()} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar igual" }));

    // El aviso es el estado de éxito de la acción (no el texto fijo del paso).
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Turno cancelado. Devolvele el pago a tu cliente desde tu cuenta de Mercado Pago.",
    );
    expect(screen.queryByRole("button", { name: "Cancelar igual" })).toBeNull();
  });

  it("muestra el error de la cancelación", async () => {
    cancelPaidBookingAction.mockResolvedValue({ status: "error", message: "No pudimos cancelar el turno." });
    render(<BookingLifecycleActions booking={paid()} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar igual" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos cancelar el turno.");
  });

  it("un turno NO pagado sigue cancelándose con el submit de siempre", () => {
    render(<BookingLifecycleActions booking={upcoming("confirmed")} />);

    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("button", { name: "Cancelar igual" })).toBeNull();
  });

  it("un turno que espera pago (hold) tampoco pasa por el paso", () => {
    render(
      <BookingLifecycleActions booking={{ ...upcoming("pending"), paymentStatus: "awaiting" }} />,
    );

    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveAttribute("type", "submit");
  });
});
