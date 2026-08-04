import type { BookingStatus } from "./types";

/**
 * Ciclo de vida de un turno: qué estados puede alcanzar cada estado.
 *
 * La base define los cinco valores del enum `booking_status`, pero NO qué
 * camino es válido entre ellos: un UPDATE puede llevar un turno de 'completed'
 * a 'pending' sin que Postgres se queje. Esa regla es de negocio y vive acá,
 * en una sola fuente que usan la Server Action (autoritativa) y la UI (para
 * pintar sólo los botones que corresponden).
 *
 * Dos principios:
 *   · Un turno CERRADO no se reabre. 'cancelled', 'completed' y 'no_show' son
 *     terminales: el historial no se reescribe. Si hace falta atender de nuevo
 *     al cliente, se crea un turno nuevo (y así queda en la agenda).
 *   · No se vuelve a 'pending'. Confirmar no se deshace; cancelar sí es un
 *     desenlace posible desde cualquier estado vivo.
 */
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ["confirmed", "completed", "no_show", "cancelled"],
  confirmed: ["completed", "no_show", "cancelled"],
  cancelled: [],
  completed: [],
  no_show: [],
};

/** Estados que ocupan cupo y aparecen en la agenda (ver `getBookingLoad`). */
const LIVE: BookingStatus[] = ["pending", "confirmed"];

/**
 * Etiquetas de la ACCIÓN que lleva a cada estado, en imperativo.
 *
 * No confundir con `describeBookingStatus`, que nombra el estado ya alcanzado:
 * el badge dice "Cancelado", el botón que lleva ahí dice "Cancelar".
 */
export const BOOKING_ACTION_LABELS: Record<BookingStatus, string> = {
  pending: "Marcar pendiente",
  confirmed: "Confirmar",
  cancelled: "Cancelar",
  completed: "Completar",
  no_show: "No asistió",
};

/**
 * ¿Este string suelto es uno de los cinco estados de la base?
 *
 * El estado destino viaja en un FormData, o sea llega del cliente. Sin este
 * guard, un POST armado a mano intentaría escribir un valor cualquiera en la
 * columna: la base lo rechazaría por el enum, pero con un error crudo de
 * Postgres en vez de un mensaje nuestro.
 */
export function isBookingStatus(value: string): value is BookingStatus {
  return Object.hasOwn(TRANSITIONS, value);
}

/**
 * Destinos válidos desde un estado. Devuelve lista vacía para un turno cerrado
 * y también para un estado que la base sume antes que el front, en vez de
 * romper: peor que no ofrecer una acción es ofrecer una inválida.
 */
export function allowedTransitions(from: BookingStatus): BookingStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** ¿Es válido llevar un turno de `from` a `to`? */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/** ¿El turno sigue vivo, es decir ocupa cupo en la agenda? */
export function isLiveBooking(status: BookingStatus): boolean {
  return LIVE.includes(status);
}

/**
 * Sólo se mueve en el tiempo un turno vivo. Reprogramar uno cancelado lo
 * resucitaría por la puerta de atrás, salteando el ciclo de vida.
 */
export function canReschedule(status: BookingStatus): boolean {
  return isLiveBooking(status);
}
