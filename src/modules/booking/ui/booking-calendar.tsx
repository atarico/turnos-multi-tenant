"use client";

import "react-day-picker/style.css";

import { type CSSProperties, useState } from "react";
import { TZDate } from "@date-fns/tz";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
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

const navButton = cn(
  "inline-flex size-8 items-center justify-center rounded-lg border border-border",
  "text-muted transition-colors hover:border-gold/40 hover:text-gold",
  "disabled:pointer-events-none disabled:opacity-30",
);

// El botón de cada día. Los estados (seleccionado, hoy, deshabilitado) los
// marca react-day-picker v10 con `data-*` en el <td> padre; los targeteamos con
// variantes arbitrarias en lugar de pelear con la especificidad del CSS default.
const dayButton = cn(
  "inline-flex size-10 items-center justify-center rounded-xl text-sm font-medium text-foreground",
  "transition-colors hover:bg-surface-2",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
  // Hoy (cuando NO está seleccionado): acento dorado sutil.
  "[[data-today=true]:not([data-selected=true])_&]:text-gold-bright",
  "[[data-today=true]:not([data-selected=true])_&]:font-semibold",
  // Seleccionado: pill dorada sólida con leve glow.
  "[[data-selected=true]_&]:bg-gold [[data-selected=true]_&]:text-on-gold",
  "[[data-selected=true]_&]:font-semibold",
  "[[data-selected=true]_&]:shadow-[0_4px_16px_-6px_rgba(227,178,60,0.6)]",
  "[[data-selected=true]_&]:hover:bg-gold-bright",
);

/**
 * Calendario interactivo (react-day-picker v10) con estética dark premium.
 * Deshabilita el pasado y los días de la semana sin disponibilidad del
 * profesional. La accesibilidad (teclado, ARIA) la aporta react-day-picker.
 *
 * El tamaño y el espaciado de las celdas se fijan por `classNames` (Tailwind),
 * NO por el stylesheet del paquete: su dimensionado no sobrevive al reset de
 * Tailwind y dejaba la grilla comprimida. Sólo conservamos dos variables
 * `--rdp-*` para neutralizar el borde/acento por defecto del día seleccionado.
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

  // Neutraliza el borde y el agrandado del día seleccionado que trae el CSS
  // default; el relleno dorado lo pone `dayButton`.
  const theme = {
    "--rdp-accent-color": "var(--color-gold)",
    "--rdp-selected-border": "0",
  } as CSSProperties;

  return (
    <div style={theme} className="w-fit text-foreground">
      <DayPicker
        mode="single"
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
        locale={es}
        weekStartsOn={1}
        showOutsideDays
        startMonth={today}
        components={{
          Chevron: ({ orientation }) =>
            orientation === "left" ? (
              <ChevronLeft className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            ),
        }}
        classNames={{
          months: "relative",
          month: "space-y-3",
          month_caption: "flex h-9 items-center",
          caption_label:
            "font-display text-base font-semibold tracking-tight capitalize",
          nav: "absolute right-0 top-0 flex h-9 items-center gap-1",
          button_previous: navButton,
          button_next: navButton,
          month_grid: "w-full border-separate border-spacing-1",
          weekdays: "",
          weekday:
            "pb-2 text-[0.7rem] font-semibold uppercase tracking-widest text-faint",
          week: "",
          // Celda: alto fijo para alinear también los días deshabilitados
          // (que NO renderizan botón, sólo texto atenuado).
          day: "h-10 p-0 text-center align-middle text-sm text-faint/30",
          day_button: dayButton,
        }}
      />
    </div>
  );
}
