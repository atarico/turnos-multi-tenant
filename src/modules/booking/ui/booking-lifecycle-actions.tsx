"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";

import { idleState } from "@/core/action";
import { Button } from "@/components/ui/button";

import { formatPrice } from "@/modules/catalog/domain/money";

import {
  cancelPaidBookingAction,
  updateBookingStatusAction,
} from "../application/booking-lifecycle";
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
 * Un turno PAGADO no se cancela con el submit de siempre: "Cancelar" abre un
 * paso que ofrece reprogramar primero (la plata queda donde está) y sólo
 * "Cancelar igual" llama a `cancelPaidBookingAction`, que lo deja con la
 * devolución pendiente. La Server Action de arriba rechazaría ese POST igual.
 *
 * Un solo `<form>` con varios submit: el `name`/`value` del botón apretado es
 * lo que viaja como `status`, así no hace falta un form por acción.
 */
export function BookingLifecycleActions({ booking }: BookingLifecycleActionsProps) {
  const [state, formAction, pending] = useActionState(
    updateBookingStatusAction,
    idleState,
  );

  const [paidState, paidAction, paidPending] = useActionState(
    cancelPaidBookingAction,
    idleState,
  );
  const [askingPaidCancel, setAskingPaidCancel] = useState(false);

  // Tras cancelar con éxito la fila puede seguir montada un instante: el aviso
  // de la devolución no puede depender de que `transitions` no esté vacío.
  if (paidState.status === "success") {
    return (
      <p role="status" className="max-w-xs text-right text-xs text-muted">
        {paidState.message}
      </p>
    );
  }

  const transitions = allowedTransitionsAt(booking.status, booking.endsAt);
  if (transitions.length === 0) return null;

  const isPaid = booking.paymentStatus === "paid";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <form action={formAction} className="flex flex-wrap gap-1.5">
          <input type="hidden" name="id" value={booking.id} />
          {transitions.map((status) =>
            isPaid && status === "cancelled" ? (
              <Button
                key={status}
                type="button"
                size="sm"
                variant="danger"
                onClick={() => setAskingPaidCancel(true)}
              >
                {BOOKING_ACTION_LABELS[status]}
              </Button>
            ) : (
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
            ),
          )}
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

      {isPaid && askingPaidCancel && (
        <div className="flex max-w-sm flex-col items-end gap-2 rounded-xl border border-gold/30 bg-gold/10 p-3 text-right">
          <p className="text-sm text-foreground">
            Este turno está pagado ({formatPrice(booking.priceCents, booking.currency)}).
            ¿Lo reprogramás en vez de cancelarlo?
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Link
              href={`/panel/turnos/${booking.id}/reprogramar`}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-medium tracking-tight text-foreground transition-all hover:border-gold/40 hover:bg-surface"
            >
              <CalendarClock className="size-4" />
              Reprogramar
            </Link>
            <form action={paidAction}>
              <input type="hidden" name="id" value={booking.id} />
              <Button type="submit" size="sm" variant="danger" disabled={paidPending}>
                Cancelar igual
              </Button>
            </form>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setAskingPaidCancel(false)}
            >
              Volver
            </Button>
          </div>
          <p className="text-xs text-muted">
            Si lo cancelás, la devolución la hacés vos desde tu cuenta de
            Mercado Pago.
          </p>
          {paidState.status === "error" && (
            <p role="alert" className="text-xs text-danger">
              {paidState.message}
            </p>
          )}
        </div>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-xs text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}
