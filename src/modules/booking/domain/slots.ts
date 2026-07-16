import { TZDate } from "@date-fns/tz";
import { addMinutes } from "date-fns";

import type { AvailableSlot, BookingLoad, WeeklyAvailability } from "./types";

/**
 * Entrada de {@link generateSlots}. Todo lo necesario para decidir qué franjas
 * mostrar en una fecha, sin tocar la base ni depender de la timezone de la
 * máquina: los instantes se calculan siempre en la timezone del negocio.
 */
export interface SlotGenerationInput {
  /** Día elegido en el calendario. Se leen sus campos Y/M/D como fecha civil. */
  date: Date;
  /** Timezone del negocio (ej. "America/Argentina/Buenos_Aires"). */
  timezone: string;
  /** Servicio a reservar: define la "misma sesión" para el cupo grupal. */
  serviceId: string;
  /** Duración de la sesión en minutos. */
  durationMin: number;
  /** Cupos por franja del servicio. */
  capacity: number;
  /** Horario semanal del profesional (todas sus ventanas). */
  windows: WeeklyAvailability[];
  /** Reservas vivas del profesional que solapan el día. */
  load: BookingLoad[];
  /**
   * Paso entre inicios de franja en minutos. Por defecto = duración
   * (franjas espalda con espalda). Poné otro valor para grillas más finas.
   */
  stepMin?: number;
  /** Ahora, para descartar franjas ya pasadas. Inyectable para tests. */
  now?: Date;
}

/** "HH:mm" o "HH:mm:ss" → minutos desde medianoche. Devuelve null si es inválido. */
function timeToMinutes(time: string): number | null {
  const parts = time.split(":");
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * Instante → ISO canónico en UTC ("…Z"). `TZDate.toISOString()` conserva el
 * offset del negocio ("…-03:00"); acá lo normalizamos a Z para que sea el mismo
 * formato que devuelve la base y que acepta `z.iso.datetime()` por defecto.
 */
function toUtcIso(instant: Date): string {
  return new Date(instant.getTime()).toISOString();
}

/** Minutos desde medianoche → "HH:mm" con cero a la izquierda. */
function minutesToLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Genera las franjas reservables de un día para un profesional y servicio.
 *
 * Función PURA y unit-testeable: mismas entradas, mismas salidas. Refleja la
 * lógica de cupo de `create_booking()` (sesión grupal vs. profesional ocupado)
 * para no OFRECER lo que la base va a rechazar, pero la autoridad final sigue
 * siendo la RPC al confirmar (advisory lock + revalidación).
 */
export function generateSlots(input: SlotGenerationInput): AvailableSlot[] {
  const {
    date,
    timezone,
    serviceId,
    durationMin,
    capacity,
    windows,
    load,
    stepMin = durationMin,
    now = new Date(),
  } = input;

  if (durationMin <= 0 || stepMin <= 0) return [];

  // Fecha civil del día elegido. Se leen los campos locales del Date recibido:
  // react-day-picker entrega medianoche local, así que Y/M/D son los correctos.
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  // El día de la semana es función de la fecha civil; el mediodía evita
  // cualquier ambigüedad de DST al pedir getDay() en la timezone del negocio.
  const weekday = new TZDate(year, month, day, 12, 0, 0, timezone).getDay();

  const nowMs = now.getTime();
  const slots = new Map<string, AvailableSlot>();

  for (const window of windows) {
    if (window.weekday !== weekday) continue;

    const startMin = timeToMinutes(window.startTime);
    const endMin = timeToMinutes(window.endTime);
    if (startMin === null || endMin === null || endMin <= startMin) continue;

    for (let t = startMin; t + durationMin <= endMin; t += stepMin) {
      const hours = Math.floor(t / 60);
      const minutes = t % 60;

      const startsAt = new TZDate(year, month, day, hours, minutes, 0, timezone);

      // Hueco de DST (spring-forward): si la hora civil pedida NO existe en la
      // timezone del negocio, TZDate la normaliza HACIA ADELANTE (ej. las 02:00
      // inexistentes se vuelven 03:00 EDT). Eso produciría una franja con la
      // etiqueta equivocada Y colisionaría con la franja real de las 03:00.
      // La detectamos comprobando que la hora/minuto civil hagan round-trip:
      // si no coinciden, esa hora local no existe → descartamos la candidata.
      if (startsAt.getHours() !== hours || startsAt.getMinutes() !== minutes) {
        continue;
      }

      const startsAtMs = startsAt.getTime();

      // No ofrecemos franjas que ya pasaron (afecta sólo al día de hoy).
      if (startsAtMs <= nowMs) continue;

      const endsAt = addMinutes(startsAt, durationMin);
      const endsAtMs = endsAt.getTime();
      const startsAtIso = toUtcIso(startsAt);

      // Dedupe: ventanas superpuestas podrían generar la misma franja.
      if (slots.has(startsAtIso)) continue;

      // Ocupación: reservas vivas del profesional que solapan esta franja.
      let taken = 0; // misma sesión (mismo servicio + mismo inicio)
      let others = 0; // otra sesión distinta que lo mantiene ocupado
      for (const booking of load) {
        const bStart = Date.parse(booking.startsAt);
        const bEnd = Date.parse(booking.endsAt);
        const overlaps = bStart < endsAtMs && bEnd > startsAtMs;
        if (!overlaps) continue;
        const sameSession =
          booking.serviceId === serviceId && bStart === startsAtMs;
        if (sameSession) taken += 1;
        else others += 1;
      }

      const remaining = others > 0 ? 0 : Math.max(0, capacity - taken);

      slots.set(startsAtIso, {
        startsAt: startsAtIso,
        endsAt: toUtcIso(endsAt),
        label: minutesToLabel(t),
        available: remaining > 0,
        remaining,
      });
    }
  }

  return [...slots.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * Días de la semana (0=domingo … 6=sábado) en los que el profesional tiene
 * alguna ventana de atención. Sirve para deshabilitar en el calendario los
 * días sin disponibilidad.
 */
export function availableWeekdays(windows: WeeklyAvailability[]): number[] {
  return [...new Set(windows.map((w) => w.weekday))].sort((a, b) => a - b);
}
