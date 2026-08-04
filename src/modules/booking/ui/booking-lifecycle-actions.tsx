"use client";

import { useActionState } from "react";

import { idleState } from "@/core/action";
import { Button } from "@/components/ui/button";

import { updateBookingStatusAction } from "../application/booking-lifecycle";
import {
  BOOKING_ACTION_LABELS,
  allowedTransitions,
} from "../domain/booking-transitions";
import type { AgendaBooking, BookingStatus } from "../domain/types";

interface BookingLifecycleActionsProps {
  booking: AgendaBooking;
}

/** Peso visual de cada acción: cancelar avisa, confirmar empuja. */
const VARIANTS: Partial<
  Record<BookingStatus, "primary" | "secondary" | "outline" | "danger">
> = {
  confirmed: "primary",
  cancelled: "danger",
};

/**
 * Acciones de ciclo de vida de UN turno de la agenda.
 *
 * Los botones que se muestran salen de `allowedTransitions`, la misma regla de
 * dominio que valida la Server Action: la UI no puede ofrecer un cambio que el
 * servidor va a rechazar. Un turno ya cerrado no renderiza nada.
 *
 * Un solo `<form>` con varios submit: el `name`/`value` del botón apretado es
 * lo que viaja como `status`, así no hace falta un form por acción.
 */
export function BookingLifecycleActions({ booking }: BookingLifecycleActionsProps) {
  const [state, formAction, pending] = useActionState(
    updateBookingStatusAction,
    idleState,
  );

  const transitions = allowedTransitions(booking.status);
  if (transitions.length === 0) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <form action={formAction} className="flex flex-wrap gap-1.5">
          <input type="hidden" name="id" value={booking.id} />
          {transitions.map((status) => (
            <Button
              key={status}
              type="submit"
              name="status"
              value={status}
              size="sm"
              variant={VARIANTS[status] ?? "secondary"}
              disabled={pending}
            >
              {BOOKING_ACTION_LABELS[status]}
            </Button>
          ))}
        </form>
      </div>

      {state.status === "error" && (
        <p role="alert" className="text-xs text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}
