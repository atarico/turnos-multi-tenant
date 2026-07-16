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
