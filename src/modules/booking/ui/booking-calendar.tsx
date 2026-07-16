"use client";

import "react-day-picker/style.css";

import { type CSSProperties, useState } from "react";
import { TZDate } from "@date-fns/tz";
import { es } from "date-fns/locale";
import { DayPicker, type Matcher } from "react-day-picker";

import { cn } from "@/lib/utils/cn";

interface BookingCalendarProps {
  /** Día seleccionado (o undefined si todavía no eligieron). */
  selected: Date | undefined;
  onSelect: (date: Date | undefined) => void;
  /** Días de la semana con atención (0=domingo … 6=sábado). */
  weekdays: number[];
  /** Timezone del negocio: define qué día es "hoy" para el corte del pasado. */
  timezone: string;
}

/**
 * Calendario interactivo (react-day-picker v10) con estética dark premium.
 * Deshabilita el pasado y los días de la semana sin disponibilidad del
 * profesional. La accesibilidad (teclado, ARIA) la aporta react-day-picker.
 *
 * El tema dorado se aplica sobreescribiendo las CSS variables `--rdp-*`; el
 * layout base viene del stylesheet importado arriba.
 */
export function BookingCalendar({
  selected,
  onSelect,
  weekdays,
  timezone,
}: BookingCalendarProps) {
  // "Hoy" en la timezone del NEGOCIO, no la del navegador: un cliente en otro
  // huso no debe ver habilitado/deshabilitado un día distinto al del negocio.
  // Leemos los campos civiles en esa tz y los pasamos a un Date local que
  // react-day-picker compara por fecha civil. Se calcula una sola vez con un
  // inicializador perezoso: leer el reloj en render sería impuro.
  const [today] = useState(() => {
    const nowInTz = new TZDate(Date.now(), timezone);
    return new Date(
      nowInTz.getFullYear(),
      nowInTz.getMonth(),
      nowInTz.getDate(),
    );
  });

  const openDays = new Set(weekdays);
  const disabled: Matcher[] = [
    { before: today },
    (date: Date) => !openDays.has(date.getDay()),
  ];

  // Tema dorado sobre las variables de react-day-picker.
  const theme = {
    "--rdp-accent-color": "var(--color-gold)",
    "--rdp-accent-background-color": "color-mix(in oklab, var(--color-gold) 18%, transparent)",
    "--rdp-today-color": "var(--color-gold-bright)",
    "--rdp-day_button-border-radius": "0.75rem",
    "--rdp-day-width": "2.5rem",
    "--rdp-day-height": "2.5rem",
    "--rdp-day_button-width": "2.5rem",
    "--rdp-day_button-height": "2.5rem",
  } as CSSProperties;

  return (
    <div style={theme} className="text-foreground">
      <DayPicker
        mode="single"
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
        locale={es}
        weekStartsOn={1}
        showOutsideDays
        startMonth={today}
        classNames={{
          months: "relative",
          month_caption: "flex items-center h-11 px-1",
          caption_label: "font-display text-base font-semibold tracking-tight capitalize",
          nav: "absolute right-1 top-0 flex items-center gap-1 h-11",
          button_previous: cn(
            "inline-flex size-9 items-center justify-center rounded-lg border border-border",
            "text-muted transition-colors hover:border-gold/40 hover:text-foreground",
          ),
          button_next: cn(
            "inline-flex size-9 items-center justify-center rounded-lg border border-border",
            "text-muted transition-colors hover:border-gold/40 hover:text-foreground",
          ),
          weekday: "text-xs font-medium text-faint",
          day: "text-sm",
          day_button: cn(
            "font-medium text-foreground transition-colors",
            "hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
          ),
          today: "text-gold-bright font-semibold",
          selected: "text-on-gold",
          disabled: "text-faint opacity-40",
          outside: "text-faint/60",
        }}
      />
    </div>
  );
}
