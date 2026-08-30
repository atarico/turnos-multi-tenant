import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";

/**
 * Una fecha del panel de plataforma, siempre en UTC.
 *
 * Acá no hay un negocio cuya zona horaria usar: se ven todos, de países
 * distintos. Dejarlo a la tz del servidor haría que la misma alta se viera en
 * un día u otro según dónde corra el render, que es la clase de diferencia que
 * después nadie puede explicar. UTC es arbitrario pero es igual para todos.
 *
 * El chequeo de fecha inválida NO es paranoia de tipos: las fechas llegan de
 * PostgREST como `string` por un cast sin validar, y ante un valor que no se
 * puede parsear `format` tira `RangeError`. Esto corre adentro de un `map`, así
 * que esa excepción no se llevaría una fila: se lleva el render de la lista
 * ENTERA, y el operador ve una pantalla rota por culpa de un dato. Un guion es
 * una fila fea; una excepción es una pantalla que no existe.
 */
export function utcDateLabel(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  return format(new TZDate(ms, "UTC"), "d MMM yyyy", { locale: es });
}
