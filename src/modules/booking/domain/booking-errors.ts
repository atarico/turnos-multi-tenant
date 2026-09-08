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
  /**
   * El negocio no tiene plan activo. Al visitante se le dice QUÉ pasa y no POR
   * QUÉ: que a este negocio se le venció la prueba, que debe o que canceló es
   * información del negocio, no de quien entró a sacar un turno. Contarlo sería
   * filtrar por la puerta de adelante algo que la vista `public_tenants` se
   * cuida de no exponer.
   */
  [
    "sin plan activo",
    "Este negocio no está tomando reservas online por ahora. Escribile directo para coordinar.",
  ],
];

/**
 * Errores que sólo puede tirar `create_booking()` llamada DESDE EL PANEL, o
 * sea con el dueño del negocio del otro lado.
 *
 * Existe esta lista aparte por un solo caso, y vale la pena: es el mismo
 * rechazo de la base que el de arriba, pero quien lo lee puede resolverlo. Al
 * visitante hay que sacarlo del paso; al dueño hay que decirle exactamente qué
 * pasó y dónde se arregla, o queda mirando un cartel que no explica nada
 * mientras su agenda no toma turnos.
 */
const OWNER_BOOKING_RULES: [needle: string, message: string][] = [
  /**
   * NO dice "se te venció la prueba", y no es por prudencia: sería mentira en
   * dos de los tres casos. `tenant_takes_bookings()` rechaza por igual la
   * prueba vencida, la suscripción CANCELADA y la ausencia de suscripción, y
   * los tres llegan acá con el mismo string. A un dueño que canceló el mes
   * pasado, "se te terminó la prueba gratis" le describe algo que no pasó y lo
   * manda a buscar una prueba que ya no existe. "No tenés un plan activo" es
   * cierto en los tres, y la salida —elegir un plan— también.
   */
  [
    "sin plan activo",
    "Tu negocio no tiene un plan activo, así que no entran turnos nuevos. Tu agenda sigue intacta: elegí un plan en Suscripción y vuelve a andar.",
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

/** Reserva hecha por un VISITANTE, desde la página pública `/{slug}`. */
export function friendlyBookingError(message: string): string {
  return translate(
    message,
    [...PUBLIC_BOOKING_RULES, ...SHARED_RULES],
    "No pudimos crear la reserva. Revisá los datos e intentá de nuevo.",
  );
}

/**
 * Reserva cargada por el DUEÑO, desde el panel.
 *
 * Comparte todas las reglas de la franja —cupo, solape, disponibilidad— porque
 * el motor es el mismo; lo único que cambia es a quién se le habla. Las reglas
 * del visitante quedan afuera a propósito: el freno anti-spam y el origen no
 * identificado son de `create_public_booking()`, que el panel no llama nunca.
 */
export function friendlyOwnerBookingError(message: string): string {
  return translate(
    message,
    [...OWNER_BOOKING_RULES, ...SHARED_RULES],
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
