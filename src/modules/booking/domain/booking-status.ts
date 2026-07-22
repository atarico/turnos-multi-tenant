import type { BookingStatus } from "./types";

/** Cómo se pinta un estado de turno: etiqueta legible + tono del Badge. */
export interface BookingStatusDescriptor {
  label: string;
  tone: "gold" | "success" | "danger" | "info" | "muted";
}

const DESCRIPTORS: Record<BookingStatus, BookingStatusDescriptor> = {
  pending: { label: "Pendiente", tone: "gold" },
  confirmed: { label: "Confirmado", tone: "success" },
  cancelled: { label: "Cancelado", tone: "danger" },
  completed: { label: "Completado", tone: "info" },
  no_show: { label: "No asistió", tone: "muted" },
};

/**
 * Traduce el estado crudo de la base a etiqueta + tono para la UI. Si la base
 * suma un estado nuevo antes que el front, cae en un badge neutro con el valor
 * literal en vez de romper.
 */
export function describeBookingStatus(
  status: BookingStatus,
): BookingStatusDescriptor {
  return DESCRIPTORS[status] ?? { label: status, tone: "muted" };
}
