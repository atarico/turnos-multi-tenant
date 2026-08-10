/**
 * Traduce los errores crudos de las RPC del motor de turnos
 * (`create_booking()`, `create_public_booking()` y `reschedule_booking()`) a
 * algo accionable para quien los lee.
 *
 * Fuente ÚNICA de estos mensajes: los usan el panel (autenticado) y la página
 * pública (anónima). Las tres RPC comparten el grueso de las validaciones
 * —`create_public_booking()` delega en `create_booking()`—, así que el usuario
 * tiene que leer lo mismo venga por donde venga; dos copias divergen apenas
 * alguien ajusta un texto de un solo lado.
 *
 * Lo que NO comparten va en su propia lista: mezclar todo haría que reprogramar
 * pudiera contestar un mensaje que su RPC no puede tirar nunca.
 *
 * Compartir esto NO cruza la frontera low-trust / high-trust: esa frontera vive
 * en el acceso a datos y la identidad, no en un mapeo puro de strings.
 */

/**
 * Reglas compartidas por crear y reprogramar: las dos operaciones validan
 * exactamente lo mismo (cupo, solape, disponibilidad, franja pasada), así que
 * el mensaje tiene que ser idéntico. El ORDEN importa: "profesional no
 * disponible" y "servicio no disponible" comparten subcadena.
 */
const SHARED_RULES: [needle: string, message: string][] = [
  ["no quedan lugares", "No quedan lugares en esa franja. Elegí otra."],
  ["ya tiene un turno", "El profesional ya tiene un turno en ese horario."],
  ["no atiende", "El profesional no atiende en ese horario."],
  ["ya pasó", "Esa franja ya pasó. Elegí otra."],
  ["no ofrece", "Ese profesional no ofrece este servicio."],
  ["profesional no disponible", "El profesional no está disponible."],
  ["servicio no disponible", "El servicio no está disponible."],
  ["negocio inexistente", "No encontramos ese negocio."],
];

/**
 * Errores que sólo puede tirar `create_public_booking()`, o sea el visitante
 * anónimo. Ni el panel ni reprogramar pueden llegar acá: la RPC que los tira no
 * está en esos caminos.
 *
 * Van PRIMERO que las de franja: el freno no es un problema con el horario
 * elegido, así que contestar "elegí otra" sería un consejo inútil.
 */
const PUBLIC_BOOKING_RULES: [needle: string, message: string][] = [
  [
    "demasiadas reservas",
    "Hiciste varias reservas seguidas. Esperá un rato y volvé a intentar.",
  ],
  [
    "origen no identificado",
    "No pudimos procesar la reserva desde este origen. Probá de nuevo.",
  ],
];

/** Errores que sólo puede tirar `reschedule_booking()`. */
const RESCHEDULE_RULES: [needle: string, message: string][] = [
  ["turno inexistente", "No encontramos ese turno."],
  ["ya está cerrado", "Ese turno ya está cerrado: no se puede reprogramar."],
];

function translate(
  message: string,
  rules: [needle: string, message: string][],
  fallback: string,
): string {
  const m = message.toLowerCase();
  for (const [needle, friendly] of rules) {
    if (m.includes(needle)) return friendly;
  }
  return fallback;
}

export function friendlyBookingError(message: string): string {
  return translate(
    message,
    [...PUBLIC_BOOKING_RULES, ...SHARED_RULES],
    "No pudimos crear la reserva. Revisá los datos e intentá de nuevo.",
  );
}

/**
 * Mismo mapeo que al crear, más los errores propios de mover un turno. Las
 * reglas específicas van PRIMERO: son las más precisas.
 */
export function friendlyRescheduleError(message: string): string {
  return translate(
    message,
    [...RESCHEDULE_RULES, ...SHARED_RULES],
    "No pudimos reprogramar el turno. Intentá de nuevo.",
  );
}
