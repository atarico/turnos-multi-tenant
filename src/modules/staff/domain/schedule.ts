import { appError, err, ok, type Result } from "@/core/result";

/**
 * Horario semanal recurrente de un profesional (`staff_availability`).
 *
 * Los `weekday` son los de `extract(dow)` de Postgres: 0 = domingo … 6 = sábado.
 * Las horas son LOCALES del negocio (se interpretan con `tenants.timezone`),
 * nunca UTC: "abro a las 9" significa 9 en el reloj de la pared.
 */

export interface ScheduleWindow {
  weekday: number;
  /** "HH:MM" en hora local del negocio. */
  startTime: string;
  endTime: string;
}

/** Franja tal como llega del formulario, sin validar. */
export interface RawScheduleWindow {
  weekday: string;
  startTime: string;
  endTime: string;
}

/**
 * La semana en el orden en que la lee una persona (lunes primero), conservando
 * el valor que espera la base. El orden de lectura y el valor almacenado son
 * dos cosas distintas y mezclarlas es la forma clásica de correr todo un día.
 */
export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Lunes" },
  { value: 2, label: "Martes" },
  { value: 3, label: "Miércoles" },
  { value: 4, label: "Jueves" },
  { value: 5, label: "Viernes" },
  { value: 6, label: "Sábado" },
  { value: 0, label: "Domingo" },
];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

/**
 * "09:00:00" (lo que devuelve una columna `time`) → "09:00" (lo que espera un
 * `<input type="time">`). Devuelve `null` si no es una hora del día válida.
 */
export function normalizeTime(value: string): string | null {
  const match = TIME_PATTERN.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

/** "HH:MM" → minutos desde medianoche. Sólo para comparar franjas. */
function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Franjas crudas del formulario → horario semanal validado y ordenado.
 *
 * La base cubre `end_time > start_time` con un check, pero NO conoce el solape
 * entre franjas del mismo día: eso se valida acá. Dos ventanas que se pisan
 * harían que el generador de slots ofrezca el mismo horario dos veces.
 */
export function buildWeeklySchedule(
  rows: RawScheduleWindow[],
): Result<ScheduleWindow[]> {
  const windows: ScheduleWindow[] = [];

  for (const row of rows) {
    const weekday = Number(row.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return err(appError("invalid_weekday", "Hay un día de la semana inválido."));
    }

    const startTime = normalizeTime(row.startTime);
    const endTime = normalizeTime(row.endTime);
    if (!startTime || !endTime) {
      return err(appError("invalid_time", "Revisá las horas: alguna no es válida."));
    }

    if (toMinutes(endTime) <= toMinutes(startTime)) {
      return err(
        appError("invalid_range", "Cada franja tiene que terminar después de empezar."),
      );
    }

    windows.push({ weekday, startTime, endTime });
  }

  windows.sort(
    (a, b) =>
      a.weekday - b.weekday || toMinutes(a.startTime) - toMinutes(b.startTime),
  );

  // Ya ordenadas, alcanza con comparar cada franja con la anterior del mismo día.
  for (let i = 1; i < windows.length; i++) {
    const previous = windows[i - 1];
    const current = windows[i];
    if (
      previous.weekday === current.weekday &&
      toMinutes(current.startTime) < toMinutes(previous.endTime)
    ) {
      return err(
        appError(
          "overlapping_windows",
          "Hay franjas que se pisan en el mismo día. Revisalas.",
        ),
      );
    }
  }

  return ok(windows);
}
