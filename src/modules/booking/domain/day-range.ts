import { TZDate } from "@date-fns/tz";

/** Un día civil resuelto en la timezone del negocio. */
export type DayRange = {
  /**
   * Fecha civil como `Date` local del runtime (medianoche local). `generateSlots`
   * lee de acá los campos Y/M/D; no representa un instante real del día.
   */
  date: Date;
  /** Primer instante del día civil, ISO UTC ("…Z"). Inclusivo. */
  startIso: string;
  /** Primer instante del día siguiente, ISO UTC ("…Z"). Exclusivo. */
  endIso: string;
};

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Instante → ISO canónico en UTC; `TZDate.toISOString()` conservaría el offset. */
function toUtcIso(instant: Date): string {
  return new Date(instant.getTime()).toISOString();
}

/**
 * Resuelve "YYYY-MM-DD" al rango [inicio de día, inicio del día siguiente) en la
 * timezone del negocio, listo para filtrar columnas `timestamptz`.
 *
 * Fuente ÚNICA de esta aritmética: la usan tanto el camino autenticado del panel
 * como el público. Dos copias divergirían en los bordes de DST, que es justo
 * donde nadie mira.
 *
 * El fin se construye como el día civil SIGUIENTE, no como `addDays(inicio, 1)`.
 * Donde el salto de DST cae sobre la medianoche (Chile cambia a las 24:00), esa
 * medianoche no existe: `TZDate` normaliza el inicio hacia adelante (01:00) y
 * `addDays` arrastraría esa hora al día siguiente, devolviendo 24h para un día
 * civil que dura 23 y comiéndose la primera hora del día siguiente.
 *
 * Devuelve `null` si la fecha está mal formada o no existe (ej. "2026-02-30").
 */
export function resolveDayRange(dateStr: string, timezone: string): DayRange | null {
  const match = CIVIL_DATE.exec(dateStr);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-trip: el Date normaliza los desbordes en silencio ("2026-02-30" → 2 de
  // marzo). Si los campos no vuelven iguales, la fecha civil no existe.
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  const start = new TZDate(year, month - 1, day, 0, 0, 0, timezone);
  const end = new TZDate(year, month - 1, day + 1, 0, 0, 0, timezone);

  return { date, startIso: toUtcIso(start), endIso: toUtcIso(end) };
}
