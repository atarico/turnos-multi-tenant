"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { CalendarCheck, CalendarDays, Users } from "lucide-react";

import { idleState } from "@/core/action";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";

import {
  getAvailabilityAction,
  getSlotsAction,
} from "../application/actions";
import { rescheduleBookingAction } from "../application/booking-lifecycle";
import type {
  AvailableSlot,
  BookableStaff,
  BookingDetail,
} from "../domain/types";
import { BookingCalendar } from "./booking-calendar";
import { SlotGrid } from "./slot-grid";

interface RescheduleFlowProps {
  booking: BookingDetail;
  /** Profesionales que ofrecen ESE servicio: los únicos destinos válidos. */
  staffList: BookableStaff[];
  timezone: string;
}

/** Date → "YYYY-MM-DD" en campos civiles locales (sin desfase de tz). */
function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Instante ISO → "vie 12 de sep, 14:30" en la tz del negocio. */
function formatWhen(iso: string, timezone: string): string {
  return format(
    new TZDate(new Date(iso).getTime(), timezone),
    "EEE d 'de' MMM, HH:mm",
    { locale: es },
  );
}

/**
 * Mueve un turno existente a otra franja, y si hace falta a otro profesional.
 *
 * A diferencia de `BookingFlow`, acá el servicio y el cliente NO se tocan: es
 * el mismo turno, corrido. Por eso no hay paso de servicio ni formulario de
 * cliente, y el servicio no se puede cambiar (cambiaría duración y precio, o
 * sea sería otro turno).
 *
 * Importa las Server Actions directamente en vez de recibirlas por prop como
 * `BookingFlow`: aquel flujo tiene DOS consumidores (panel y página pública,
 * con acciones distintas), éste sólo vive en el panel autenticado.
 */
export function RescheduleFlow({
  booking,
  staffList,
  timezone,
}: RescheduleFlowProps) {
  const [staffId, setStaffId] = useState(booking.staffId);
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);

  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [state, formAction, pending] = useActionState(
    rescheduleBookingAction,
    idleState,
  );

  // La disponibilidad se recarga cada vez que cambia el profesional destino:
  // cada uno atiende días distintos, así que el calendario tiene que repintarse.
  //
  // El efecto sólo dispara el fetch y publica el resultado en su callback. El
  // "cargando" lo prende quien provoca el cambio (el estado inicial ya arranca
  // en true): ponerlo acá sería un setState sincrónico en el cuerpo del efecto,
  // o sea un render en cascada.
  useEffect(() => {
    let cancelled = false;

    getAvailabilityAction(staffId).then((res) => {
      if (cancelled) return;
      setScheduleLoading(false);
      if (!res.ok) {
        setLoadError(res.error.message);
        return;
      }
      setWeekdays(res.value.weekdays);
    });

    return () => {
      cancelled = true;
    };
  }, [staffId]);

  function chooseStaff(nextStaffId: string) {
    if (nextStaffId === staffId) return;
    setScheduleLoading(true);
    setLoadError(null);
    setWeekdays([]);
    setStaffId(nextStaffId);
    setDate(undefined);
    setSlots([]);
    setSlot(null);
  }

  async function chooseDate(next: Date | undefined) {
    setDate(next);
    setSlot(null);
    setSlots([]);
    if (!next) return;

    setSlotsLoading(true);
    setLoadError(null);
    const res = await getSlotsAction(booking.serviceId, staffId, toDateStr(next));
    setSlotsLoading(false);
    if (!res.ok) {
      setLoadError(res.error.message);
      return;
    }
    setSlots(res.value);
  }

  if (state.status === "success") {
    return (
      <Card className="p-8 text-center">
        <CalendarCheck className="mx-auto size-8 text-gold" />
        <h2 className="mt-4 font-display text-xl font-semibold tracking-tight">
          Turno reprogramado
        </h2>
        <p className="mt-2 text-sm text-muted">
          {slot
            ? `${booking.customerName} pasó al ${formatWhen(slot.startsAt, timezone)}.`
            : `El turno de ${booking.customerName} quedó reprogramado.`}
        </p>
        <Link
          href="/panel"
          className="mt-6 inline-flex h-11 items-center rounded-xl bg-gold px-5 text-sm font-medium tracking-tight text-on-gold transition-all hover:bg-gold-bright"
        >
          Volver a la agenda
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <p className="text-sm text-muted">Turno actual</p>
        <p className="mt-1 font-medium text-foreground">
          {booking.customerName} · {booking.serviceName}
        </p>
        <p className="text-sm text-muted">
          {formatWhen(booking.startsAt, timezone)} · {booking.staffName}
        </p>
      </Card>

      {staffList.length > 1 && (
        <Card className="p-5">
          <div className="flex items-center gap-2 text-muted">
            <Users className="size-4 text-gold" />
            <span className="text-sm">Profesional</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {staffList.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => chooseStaff(s.id)}
                className={cn(
                  "h-11 rounded-xl border px-4 text-sm font-medium tracking-tight transition-all",
                  s.id === staffId
                    ? "border-gold bg-gold/10 text-gold"
                    : "border-border text-foreground hover:border-gold/40 hover:bg-surface",
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5">
        <div className="flex items-center gap-2 text-muted">
          <CalendarDays className="size-4 text-gold" />
          <span className="text-sm">Nueva fecha y hora</span>
        </div>

        {scheduleLoading ? (
          <p className="mt-4 text-sm text-muted">Cargando disponibilidad…</p>
        ) : weekdays.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            Este profesional no tiene disponibilidad cargada.
          </p>
        ) : (
          <div className="mt-4 grid gap-6 lg:grid-cols-[auto_1fr]">
            <BookingCalendar
              selected={date}
              onSelect={chooseDate}
              weekdays={weekdays}
              timezone={timezone}
            />
            <div className="min-w-0 space-y-3">
              <p className="text-sm font-medium text-muted">
                {date
                  ? format(date, "EEEE d 'de' MMMM", { locale: es })
                  : "Elegí un día en el calendario"}
              </p>
              {date && (
                <SlotGrid
                  slots={slots}
                  selected={slot?.startsAt ?? null}
                  onSelect={setSlot}
                  loading={slotsLoading}
                />
              )}
            </div>
          </div>
        )}
      </Card>

      {loadError && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger"
        >
          {loadError}
        </p>
      )}

      {state.status === "error" && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger"
        >
          {state.message}
        </p>
      )}

      <form action={formAction}>
        <input type="hidden" name="id" value={booking.id} />
        <input type="hidden" name="startsAt" value={slot?.startsAt ?? ""} />
        <input type="hidden" name="staffId" value={staffId} />
        <Button type="submit" className="w-full" disabled={!slot || pending}>
          {pending
            ? "Reprogramando…"
            : slot
              ? `Mover al ${formatWhen(slot.startsAt, timezone)}`
              : "Elegí una franja nueva"}
        </Button>
      </form>
    </div>
  );
}
