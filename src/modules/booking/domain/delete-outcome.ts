/**
 * Traduce el resultado de `delete_service()` / `delete_staff()` (RPCs de la
 * migración `20260811120001`) a la copy que ve quien intenta borrar. La RPC
 * ya hizo la cuenta por status en la base; acá sólo se decide el texto.
 *
 * Vive en `booking/domain`, no en `booking-errors.ts`: el motivo del freno es
 * sobre TURNOS (el catálogo sólo pone el sustantivo), pero no es un error de
 * RPC — es un resultado normal del enum `delete_outcome`, así que no comparte
 * el mapeo de excepciones de `booking-errors.ts`.
 */
export type DeleteOutcome = "deleted" | "blocked_upcoming" | "blocked_history";

/**
 * "servicio" y "profesional" son ambos masculinos, así que una sola plantilla
 * por outcome alcanza para los dos sujetos.
 */
const BLOCK_COPY: Record<
  Exclude<DeleteOutcome, "deleted">,
  (subject: string) => string
> = {
  blocked_upcoming: (subject) =>
    `Este ${subject} tiene turnos agendados. Cancelalos o esperá a que pasen para poder eliminarlo.`,
  blocked_history: (subject) =>
    `Este ${subject} tiene turnos completados en tu historial, así que no se puede eliminar. Pausalo para dejar de ofrecerlo.`,
};

export function deleteBlockMessage(
  outcome: Exclude<DeleteOutcome, "deleted">,
  subject: "servicio" | "profesional",
): string {
  return BLOCK_COPY[outcome](subject);
}
