"use client";

import { useActionState } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";

import { idleState } from "@/core/action";
import { Button } from "@/components/ui/button";

import { updateBookingStatusAction } from "../application/booking-lifecycle";
import {
  BOOKING_ACTION_LABELS,
  allowedTransitionsAt,
  canReschedule,
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
 * Los botones que se muestran salen de `allowedTransitionsAt`, la misma regla
 * de dominio que valida la Server Action: la UI no puede ofrecer un cambio que
 * el servidor va a rechazar. Un turno ya cerrado no renderiza nada, y uno que
 * todavía no ocurrió muestra sólo lo que se decide sobre el futuro (confirmar,
 * cancelar, reprogramar) — nunca "Completar" ni "No asistió".
 *
 * El reloj se lee en el render, no llega por prop: la lista se pinta en el
 * servidor y se hidrata en el cliente, así que ninguno de los dos instantes es
 * "el" momento. Si un turno vence justo entre los dos, el peor caso es un botón
 * de más o de menos por unos segundos; el guard autoritativo está en la Server
 * Action, que relee `ends_at` de la base.
 *
 * Un solo `<form>` con varios submit: el `name`/`value` del botón apretado es
 * lo que viaja como `status`, así no hace falta un form por acción.
 */
export function BookingLifecycleActions({ booking }: BookingLifecycleActionsProps) {
  const [state, formAction, pending] = useActionState(
    updateBookingStatusAction,
    idleState,
  );

  const transitions = allowedTransitionsAt(booking.status, booking.endsAt);
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

        {canReschedule(booking.status) && (
          <Link
            href={`/panel/turnos/${booking.id}/reprogramar`}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-medium tracking-tight text-foreground transition-all hover:border-gold/40 hover:bg-surface"
          >
            <CalendarClock className="size-4" />
            Reprogramar
          </Link>
        )}
      </div>

      {state.status === "error" && (
        <p role="alert" className="text-xs text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}
