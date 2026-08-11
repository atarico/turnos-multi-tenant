/**
 * Tipos del módulo de reservas (booking).
 *
 * Espejan las columnas de las tablas `staff`, `staff_services`,
 * `staff_availability`, `services` y `bookings` (ver migrations 0001/0003),
 * pero expuestos con nombres en camelCase para la capa de UI. Nada de acá
 * decide reglas de negocio: sólo transporta datos ya validados por la base.
 */

/** Un servicio reservable del negocio (services activos). */
export interface BookableService {
  id: string;
  name: string;
  description: string | null;
  /** Duración de la sesión en minutos. Define el largo de cada franja. */
  durationMin: number;
  priceCents: number;
  currency: string;
  /** Cupos por franja: 1 = turno 1-a-1, >1 = clase/sesión grupal. */
  capacity: number;
}

/** Un profesional que puede atender un servicio (staff activo). */
export interface BookableStaff {
  id: string;
  name: string;
  role: string | null;
  avatarUrl: string | null;
}

/**
 * Una ventana del horario semanal recurrente del profesional.
 * `weekday` sigue a Postgres `extract(dow)`: 0=domingo … 6=sábado, y
 * coincide con `Date.getDay()`. Las horas son LOCALES del negocio y se
 * interpretan con su timezone.
 */
export interface WeeklyAvailability {
  weekday: number;
  /** Hora local "HH:mm" o "HH:mm:ss". */
  startTime: string;
  endTime: string;
}

/**
 * Carga viva del profesional en una fecha: reservas 'pending'/'confirmed'
 * que ocupan cupo. Sin datos del cliente, sólo lo necesario para pintar
 * las franjas llenas y distinguir la misma sesión grupal.
 */
export interface BookingLoad {
  serviceId: string;
  /** Instante ISO (UTC) en que arranca la reserva. */
  startsAt: string;
  endsAt: string;
}

/** Estados posibles de un turno (espeja el enum `booking_status` de la base). */
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

/**
 * Un turno tal como lo muestra la agenda del panel: con nombre de cliente,
 * servicio y profesional ya resueltos, más el estado. Lo consume la vista
 * del dueño; NO expone datos internos que no se pinten.
 */
export interface AgendaBooking {
  id: string;
  customerName: string;
  customerPhone: string | null;
  serviceName: string;
  staffName: string;
  /** Instante ISO (UTC) de inicio / fin. */
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
}

/**
 * Un turno con las referencias que la agenda no necesita pintar pero sí hacen
 * falta para OPERAR sobre él: reprogramarlo exige saber qué servicio define la
 * duración y qué profesional lo atiende hoy.
 *
 * `serviceId`/`staffId` son nullable: `services`/`staff` ahora se pueden
 * borrar, y el CHECK `bookings_service_link_or_terminal` /
 * `..._staff_link_or_terminal` sólo garantiza el vínculo mientras el turno
 * sigue vivo (`pending`/`confirmed`/`completed`). Uno `cancelled`/`no_show`
 * puede quedar desvinculado para siempre — su nombre sobrevive congelado en
 * `serviceName`/`staffName`, no acá.
 */
export interface BookingDetail extends AgendaBooking {
  serviceId: string | null;
  staffId: string | null;
}

/**
 * Un turno con las referencias VIVAS ya resueltas: lo que necesita
 * `RescheduleFlow` para operar (duración del servicio, profesional a mover).
 * El CHECK de la base garantiza `serviceId`/`staffId` no nulos en cualquier
 * turno reprogramable — `isLinkedBooking` es la angostura que se lo hace
 * explícito al compilador.
 *
 * Nombrado `Linked`, no `Live`: `booking-transitions.ts` ya exporta un
 * `isLiveBooking(status)` sin relación (¿el turno ocupa agenda?). Mismo
 * módulo padre, mismo nombre, firma distinta — un import equivocado no
 * habría tirado error de tipos en la mayoría de los usos. La invariante acá
 * es precisa: ambas FK siguen VINCULADAS, no que el turno esté "vivo".
 */
export type LinkedBookingDetail = BookingDetail & {
  serviceId: string;
  staffId: string;
};

/**
 * Traduce la garantía del CHECK a un type guard. Angostar sólo
 * `booking.serviceId`/`booking.staffId` sueltos no alcanza para pasar el
 * objeto ENTERO como `LinkedBookingDetail` — TypeScript no propaga esa
 * angostura al tipo de `booking` — de ahí este guard explícito.
 */
export function isLinkedBooking(
  booking: BookingDetail,
): booking is LinkedBookingDetail {
  return booking.serviceId !== null && booking.staffId !== null;
}

/**
 * Una franja candidata para reservar, ya resuelta a instantes absolutos.
 * `available` decide QUÉ MOSTRAR habilitado; la validación autoritativa la
 * hace `create_booking()` en la base al confirmar.
 */
export interface AvailableSlot {
  /** Instante ISO (UTC) de inicio. */
  startsAt: string;
  /** Instante ISO (UTC) de fin (inicio + duración del servicio). */
  endsAt: string;
  /** Etiqueta legible en hora local del negocio, "HH:mm". */
  label: string;
  /** true si queda cupo y el profesional no está ocupado por otra sesión. */
  available: boolean;
  /** Lugares libres en la franja (capacity − ocupados). 0 si está llena. */
  remaining: number;
}
