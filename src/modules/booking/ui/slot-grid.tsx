"use client";

import { cn } from "@/lib/utils/cn";
import type { AvailableSlot } from "../domain/types";

interface SlotGridProps {
  slots: AvailableSlot[];
  /** startsAt (ISO) de la franja elegida. */
  selected: string | null;
  onSelect: (slot: AvailableSlot) => void;
  loading?: boolean;
}

/**
 * Grilla de franjas como chips seleccionables. Las llenas (sin cupo) quedan
 * deshabilitadas. Muestra los lugares restantes cuando el servicio es grupal
 * (capacity > 1, es decir remaining informa más de un lugar en algún momento).
 */
export function SlotGrid({ slots, selected, onSelect, loading }: SlotGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-11 animate-pulse rounded-xl border border-border bg-surface-2"
          />
        ))}
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-sm text-muted">
        No hay franjas disponibles para ese día. Probá con otra fecha.
      </p>
    );
  }

  // Sólo tiene sentido mostrar "lugares" si en algún momento hay más de uno.
  const showSeats = slots.some((s) => s.remaining > 1);

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {slots.map((slot) => {
        const isSelected = slot.startsAt === selected;
        return (
          <button
            key={slot.startsAt}
            type="button"
            disabled={!slot.available}
            aria-pressed={isSelected}
            onClick={() => onSelect(slot)}
            className={cn(
              "flex flex-col items-center justify-center rounded-xl border py-2 text-sm font-medium transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
              slot.available
                ? "border-border bg-surface-2 text-foreground hover:border-gold/40 hover:bg-elevated"
                : "cursor-not-allowed border-border/50 bg-surface text-faint line-through",
              isSelected &&
                "border-gold bg-gold/15 text-gold hover:border-gold hover:bg-gold/15",
            )}
          >
            <span>{slot.label}</span>
            {showSeats && slot.available && (
              <span className="text-[10px] font-normal text-muted">
                {slot.remaining} {slot.remaining === 1 ? "lugar" : "lugares"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
