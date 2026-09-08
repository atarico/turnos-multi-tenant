import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";

/**
 * Lo que hace falta para escribirle a alguien que acaba de reservar.
 *
 * Los nombres llegan RESUELTOS, no los ids: este módulo no consulta nada.
 * Armar el texto y buscar los datos son dos trabajos distintos, y separarlos
 * es lo que permite probar el contenido —que es lo delicado— sin base y sin
 * red.
 */
export interface BookingEmailData {
  tenantName: string;
  serviceName: string;
  /** Puede no haber profesional asignado: la reserva lo permite. */
  staffName: string | null;
  startsAt: Date;
  /** Zona horaria DEL NEGOCIO. Ver la nota de `whenText`. */
  timezone: string;
  customerName: string;
}

/** Un mail listo para mandar, en sus dos versiones. */
export interface BookingEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Cuándo es el turno, contado desde donde va a estar la persona.
 *
 * EN LA ZONA DEL NEGOCIO, y no es un detalle: el servidor corre en UTC, así
 * que sin convertir un turno de las 10:30 de Buenos Aires se anuncia a las
 * 13:30, y en el borde del día cae directamente otro día. De este dato depende
 * que alguien se presente o no.
 *
 * Es el mismo criterio que ya usa la pantalla de suscripción para el próximo
 * cobro: un INSTANTE se cuenta desde donde está parado el que lo mira. Acá el
 * que lo mira va a viajar hasta el negocio, así que manda la zona del negocio
 * y no la suya.
 */
function whenText(startsAt: Date, timezone: string): string {
  const local = new TZDate(startsAt, timezone);
  return format(local, "EEEE d 'de' MMMM 'a las' HH:mm", { locale: es });
}

/**
 * El mail de confirmación de una reserva.
 *
 * Es lo ÚNICO que le queda al cliente: hasta que esto existió, reservaba, veía
 * una pantalla y cerraba la pestaña sin ningún registro. Por eso lleva los
 * cuatro datos con los que se presenta el día del turno —qué, con quién,
 * cuándo y dónde— y ninguno más: un mail que hay que leer entero para
 * encontrar la hora no lo lee nadie.
 *
 * NO OFRECE CANCELAR NI REPROGRAMAR, y eso es a propósito. No existe pantalla
 * pública para que un cliente lo haga solo; ofrecerlo mandaría a buscar un
 * link que no está y terminaría con el negocio atendiendo un reclamo que
 * inventamos nosotros. Se dice la verdad: que le escriba al negocio.
 *
 * Las dos versiones dicen LO MISMO. No es prolijidad: muchos clientes de
 * correo y casi todos los filtros de spam leen la parte de texto, y una
 * versión más pobre que la otra es una trampa para quien la reciba recortada.
 */
export function buildBookingConfirmation(data: BookingEmailData): BookingEmail {
  const when = whenText(data.startsAt, data.timezone);

  // La línea del profesional se OMITE cuando no hay, en vez de mostrarse
  // vacía. Un renglón que dice "Con:" y nada al lado se lee como un error del
  // sistema, y quien lo recibe no sabe si el turno está bien tomado.
  const withStaff = data.staffName ? `\nCon: ${data.staffName}` : "";

  const text =
    `Hola ${data.customerName}, tu turno quedó confirmado.\n\n` +
    `${data.tenantName}\n` +
    `Servicio: ${data.serviceName}${withStaff}\n` +
    `Cuándo: ${when}\n\n` +
    `Si necesitás cambiarlo o cancelarlo, escribile al negocio.\n`;

  const staffRow = data.staffName
    ? `<tr><td><strong>Con:</strong></td><td>${data.staffName}</td></tr>`
    : "";

  const html =
    `<p>Hola ${data.customerName}, tu turno quedó confirmado.</p>` +
    `<h2>${data.tenantName}</h2>` +
    `<table>` +
    `<tr><td><strong>Servicio:</strong></td><td>${data.serviceName}</td></tr>` +
    staffRow +
    `<tr><td><strong>Cuándo:</strong></td><td>${when}</td></tr>` +
    `</table>` +
    `<p>Si necesitás cambiarlo o cancelarlo, escribile al negocio.</p>`;

  return {
    // El negocio va en el asunto porque es lo que se lee sin abrir, y es el
    // dato con el que la persona reconoce de qué se trata entre cincuenta
    // mails. La fecha lo acompaña por lo mismo.
    subject: `Tu turno en ${data.tenantName} — ${when}`,
    text,
    html,
  };
}
