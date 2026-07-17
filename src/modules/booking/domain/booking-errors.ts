/**
 * Traduce los errores crudos de la RPC `create_booking()` a algo accionable
 * para quien reserva.
 *
 * Fuente ÚNICA de estos mensajes: los usan el panel (autenticado) y la página
 * pública (anónima). La RPC es la misma para los dos, así que el usuario tiene
 * que leer lo mismo venga por donde venga; dos copias divergen apenas alguien
 * ajusta un texto de un solo lado.
 *
 * Compartir esto NO cruza la frontera low-trust / high-trust: esa frontera vive
 * en el acceso a datos y la identidad, no en un mapeo puro de strings.
 */
export function friendlyBookingError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("no quedan lugares")) return "No quedan lugares en esa franja. Elegí otra.";
  if (m.includes("ya tiene un turno")) return "El profesional ya tiene un turno en ese horario.";
  if (m.includes("no atiende")) return "El profesional no atiende en ese horario.";
  if (m.includes("ya pasó")) return "Esa franja ya pasó. Elegí otra.";
  if (m.includes("no ofrece")) return "Ese profesional no ofrece este servicio.";
  if (m.includes("profesional no disponible")) return "El profesional no está disponible.";
  if (m.includes("servicio no disponible")) return "El servicio no está disponible.";
  if (m.includes("negocio inexistente")) return "No encontramos ese negocio.";
  return "No pudimos crear la reserva. Revisá los datos e intentá de nuevo.";
}
