import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

import { describeBookingStatus } from "../domain/booking-status";
import type { AgendaBooking } from "../domain/types";
import { BookingLifecycleActions } from "./booking-lifecycle-actions";

interface AgendaListProps {
  bookings: AgendaBooking[];
  /** Timezone del negocio: la hora se muestra local, no en UTC. */
  timezone: string;
  /** Texto del estado vacío, según qué lista se esté pintando. */
  emptyMessage?: string;
  /**
   * Si se muestran los botones de ciclo de vida (confirmar, cerrar).
   * Apagado por defecto: la lista sigue sirviendo como vista de sólo lectura.
   */
  withActions?: boolean;
}

/** Instante ISO → fecha y hora civiles en la tz del negocio. */
function formatWhen(iso: string, timezone: string): { day: string; time: string } {
  const d = new TZDate(new Date(iso).getTime(), timezone);
  return {
    day: format(d, "EEE d 'de' MMM", { locale: es }),
    time: format(d, "HH:mm", { locale: es }),
  };
}

/**
 * Lista de próximos turnos del negocio para el panel. Presentacional puro: la
 * ruta le pasa los turnos ya resueltos y la timezone; acá sólo se formatea y
 * se pinta. La hora va SIEMPRE en la tz del negocio.
 */
export function AgendaList({
  bookings,
  timezone,
  emptyMessage = "Todavía no tenés turnos próximos. Cuando alguien reserve, aparecen acá.",
  withActions = false,
}: AgendaListProps) {
  if (bookings.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted">{emptyMessage}</p>
      </Card>
    );
  }

  return (
    <ul className="space-y-2">
      {bookings.map((b) => {
        const when = formatWhen(b.startsAt, timezone);
        const status = describeBookingStatus(b.status);
        return (
          <li key={b.id}>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 items-center gap-4">
                <div className="w-16 shrink-0 text-center">
                  <p className="text-xs capitalize tracking-wide text-muted">
                    {when.day}
                  </p>
                  <p className="font-display text-lg font-semibold tracking-tight text-gold">
                    {when.time}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {b.customerName}
                  </p>
                  <p className="truncate text-sm text-muted">
                    {b.serviceName} · {b.staffName}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={status.tone}>{status.label}</Badge>
                {withActions && <BookingLifecycleActions booking={b} />}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
