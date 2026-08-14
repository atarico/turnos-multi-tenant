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
 * Los dos desenlaces que CIERRAN un turno contando lo que pasó en la silla:
 * vino y se atendió, o no vino. Son afirmaciones sobre un hecho consumado, así
 * que no se pueden hacer sobre un turno que todavía no ocurrió.
 *
 * 'cancelled' NO está acá a propósito: cancelar es una decisión sobre el
 * futuro y es el caso normal (el cliente avisa que no viene), así que sigue
 * disponible desde el minuto cero.
 */
const CLOSING: BookingStatus[] = ["completed", "no_show"];

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

/** ¿Es válido llevar un turno de `from` a `to`, mirando sólo el estado? */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/**
 * ¿El turno ya ocurrió, es decir pasó su hora de fin?
 *
 * Mismo criterio que `listBookingsToClose`, que junta los turnos vivos con
 * `ends_at` ya pasado: lo que esa consulta lista es exactamente el conjunto
 * sobre el que tiene sentido decir "se completó" o "no vino".
 *
 * El borde es cerrado (`<= now`): en el instante exacto del fin el turno ya
 * ocurrió. Y un `endsAt` ilegible se trata como turno NO terminado — falla del
 * lado que no deja cerrar nada, porque el daño de cerrar de más (ingresos
 * inflados, servicio y profesional imborrables) es irreversible y el de cerrar
 * de menos es esperar un rato.
 */
export function hasBookingEnded(endsAt: string, now: number = Date.now()): boolean {
  const end = Date.parse(endsAt);
  return !Number.isNaN(end) && end <= now;
}

/**
 * Destinos válidos desde un estado TENIENDO EN CUENTA el reloj: la versión que
 * usan la Server Action y la UI.
 *
 * `allowedTransitions` sola nunca alcanzó: la tabla de arriba es status→status
 * y no sabe nada del tiempo, así que dejaba marcar como completado un turno de
 * la semana que viene. Eso no es un botón de más: un turno 'completed' suma a
 * los ingresos del mes y bloquea para siempre el borrado de su servicio y su
 * profesional.
 */
export function allowedTransitionsAt(
  from: BookingStatus,
  endsAt: string,
  now: number = Date.now(),
): BookingStatus[] {
  const targets = allowedTransitions(from);
  if (hasBookingEnded(endsAt, now)) return targets;
  return targets.filter((to) => !CLOSING.includes(to));
}

/** ¿Es válido llevar un turno de `from` a `to` en este momento? */
export function canTransitionAt(
  from: BookingStatus,
  to: BookingStatus,
  endsAt: string,
  now: number = Date.now(),
): boolean {
  return allowedTransitionsAt(from, endsAt, now).includes(to);
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
