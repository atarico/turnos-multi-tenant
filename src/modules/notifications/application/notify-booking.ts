import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import {
  buildBookingConfirmation,
  buildNewBookingForTenant,
  type BookingEmail,
} from "../domain/booking-email";
import { sendEmail } from "./email";

/**
 * Lo que el aviso necesita saber de la reserva recién tomada.
 *
 * Llegan los IDS del servicio y del profesional, no los nombres: quien llama
 * acaba de crear la reserva y tiene la fila, no el catálogo. Resolverlos es
 * trabajo de acá. `tenantId` se suma en este PR: hace falta para preguntarle a
 * la base a quién avisarle del lado del negocio — `tenantName` solo no
 * alcanza para esa consulta.
 */
export interface BookingCreated {
  tenantId: string;
  tenantName: string;
  /** Zona horaria DEL NEGOCIO: de eso depende que la hora del mail sirva. */
  timezone: string;
  serviceId: string;
  staffId: string | null;
  startsAt: Date;
  customerName: string;
  /** Opcional en el formulario público, así que la mayoría de las veces es null. */
  customerEmail: string | null;
}

/**
 * Cómo terminó un intento de aviso. Los cuatro se reportan, ninguno tira.
 *
 * `no_email` es el más frecuente y NO es un problema: del lado del cliente
 * el campo es opcional y la mayoría de las reservas no lo trae; del lado del
 * negocio significa que no hay ningún owner/admin con mail cargado.
 * `not_configured` es el estado mientras no exista la cuenta del proveedor.
 * Sólo `failed` merece que alguien lo mire.
 */
export type NotifyOutcome = "sent" | "no_email" | "not_configured" | "failed";

/**
 * El resultado del aviso, UNA PATA POR DESTINATARIO.
 *
 * Son dos desenlaces independientes y no uno solo: el cliente y el negocio
 * son destinatarios distintos, con datos de contacto que se resuelven por
 * caminos distintos (uno viene en la reserva, el otro se busca en la base), y
 * el fallo de uno no dice nada del otro. Colapsarlos en un único resultado
 * escondería, por ejemplo, que el cliente sí se enteró aunque el negocio no
 * tuviera a nadie con mail cargado.
 */
export interface NotifyResult {
  customer: NotifyOutcome;
  tenant: NotifyOutcome;
}

/**
 * Sin servicio, el negocio siempre es `failed`. El cliente sólo si tenía
 * mail al que escribirle: sin `customerEmail` nunca hubo dónde, y eso es
 * `no_email`, no un fallo.
 */
function lookupFailure(booking: BookingCreated): NotifyResult {
  return { customer: booking.customerEmail ? "failed" : "no_email", tenant: "failed" };
}

/** Una fila de `tenant_notification_recipients()`. */
interface RecipientRow {
  email: string;
}

/**
 * Le manda la confirmación a quien reservó.
 *
 * Ver la nota larga de `notifyBookingCreated`: nunca tira, y `no_email` no es
 * un error sino el estado más común porque el mail del cliente es opcional.
 */
async function notifyCustomer(
  booking: BookingCreated,
  serviceName: string,
  staffName: string | null,
): Promise<NotifyOutcome> {
  if (!booking.customerEmail) return "no_email";

  const email = buildBookingConfirmation({
    tenantName: booking.tenantName,
    serviceName,
    staffName,
    startsAt: booking.startsAt,
    timezone: booking.timezone,
    customerName: booking.customerName,
  });

  try {
    const sent = await sendEmail({ to: booking.customerEmail, ...email });
    if (!sent.ok) return "failed";
    return sent.value === "not_configured" ? "not_configured" : "sent";
  } catch {
    // Un `sendEmail` que TIRA no puede escaparse: si sube, tumba la pata
    // del negocio con él. Se reporta como un fallo más.
    return "failed";
  }
}

/**
 * Le avisa a los owner/admin del negocio que la reserva llegó.
 *
 * MANDA A TODOS LOS DESTINATARIOS, no sólo al primero — un negocio puede
 * tener más de un owner/admin, y todos administran el mismo local.
 *
 * DECISIÓN DE AGREGADO, con varios destinatarios: `sent` si al menos uno
 * recibió el mail (el negocio se entera igual, aunque sea por una sola
 * bandeja); `not_configured` sólo si TODOS los intentos volvieron así —es un
 * estado del proveedor, no de un destinatario puntual, así que si aparece en
 * uno aparece en todos—; `failed` en cualquier otro caso, que en la práctica
 * es "todos los intentos fallaron".
 */
async function notifyTenant(
  recipientEmails: string[],
  recipientsFailed: boolean,
  email: BookingEmail,
): Promise<NotifyOutcome> {
  if (recipientsFailed) return "failed";
  if (recipientEmails.length === 0) return "no_email";

  // `allSettled`, no `all`: un `sendEmail` que TIRA para un destinatario no
  // puede descartar los envíos que sí llegaron a los demás (finding
  // R3-send-rejection-breaks-independence).
  const settled = await Promise.allSettled(
    recipientEmails.map((to) => sendEmail({ to, ...email })),
  );
  const outcomes = settled.map((r): NotifyOutcome =>
    r.status === "fulfilled" ? (r.value.ok ? r.value.value : "failed") : "failed",
  );

  if (outcomes.some((o) => o === "sent")) return "sent";
  if (outcomes.every((o) => o === "not_configured")) return "not_configured";
  return "failed";
}

/**
 * Le avisa a quien reservó Y al negocio que le llegó una reserva.
 *
 * NUNCA TIRA Y NUNCA DEVUELVE UN ERROR QUE FRENE ALGO, y esa es la razón de
 * que devuelva un texto por cada pata en vez de un `Result`: cuando esto
 * corre, el turno YA ESTÁ TOMADO y confirmado en la base. No hay nada que
 * revertir y no hay nada que reintentar del lado del cliente. Quien llama no
 * puede hacer NADA con un fallo de acá salvo registrarlo, y un `Result`
 * invitaría a tratarlo como si pudiera.
 *
 * El orden es al revés que en el checkout, y por el mismo razonamiento: allá
 * el efecto externo va ANTES de escribir, porque escribir primero deja una
 * fila mintiendo. Acá el efecto externo va DESPUÉS, porque la reserva es lo
 * único que importa y el mail es su accesorio. Invertirlo —no confirmar el
 * turno hasta que el mail salga— le regalaría a un proveedor de correo el
 * poder de rechazar reservas.
 *
 * SIN PROFESIONAL SE MANDA IGUAL; SIN SERVICIO NO, y esto último tumba las
 * DOS patas: el servicio es el "qué" del turno, y ninguna de las dos
 * plantillas puede armarse sin ese dato. Un mail que confirma algo sin decir
 * qué es peor que ninguno.
 *
 * LAS DOS PATAS SON INDEPENDIENTES A PARTIR DE ACÁ: la consulta de
 * destinatarios del negocio corre en su propio `try`, así que si falla no se
 * lleva puesto el aviso al cliente, y los dos envíos van por `sendEmail`
 * bien separados — un proveedor que rebota para uno no dice nada del otro.
 */
export async function notifyBookingCreated(
  booking: BookingCreated,
): Promise<NotifyResult> {
  let serviceName: string | null = null;
  let staffName: string | null = null;
  let recipientEmails: string[] = [];
  let recipientsFailed = false;

  try {
    // TODO EL BLOQUE dentro del `try`, incluida la creación del cliente:
    // `createAdminClient()` revienta si falta la service-role key, y mirar
    // sólo el `error` de PostgREST deja afuera justo ese camino. Es el mismo
    // aprendizaje que ya está escrito en `checkout.ts` y en `cancel.ts`, y acá
    // pesa más: lo que se escaparía voltearía una reserva ya tomada.
    const admin = createAdminClient();

    const service = await admin
      .from("services")
      .select("name")
      .eq("id", booking.serviceId)
      .maybeSingle();
    serviceName = (service.data as { name: string } | null)?.name ?? null;

    if (booking.staffId) {
      const staff = await admin
        .from("staff")
        .select("name")
        .eq("id", booking.staffId)
        .maybeSingle();
      staffName = (staff.data as { name: string } | null)?.name ?? null;
    }

    // La consulta de destinatarios va en SU PROPIO `try`, adentro del de
    // arriba: un fallo acá (la función de la base no contesta, por ejemplo)
    // no puede tumbar el aviso al cliente, que ya tiene todo lo que necesita.
    try {
      const recipients = await admin.rpc("tenant_notification_recipients", {
        p_tenant_id: booking.tenantId,
      });

      if (recipients.error) {
        recipientsFailed = true;
      } else {
        recipientEmails = ((recipients.data ?? []) as RecipientRow[]).map(
          (row) => row.email,
        );
      }
    } catch {
      recipientsFailed = true;
    }
  } catch {
    return lookupFailure(booking);
  }

  if (!serviceName) return lookupFailure(booking);

  const customer = await notifyCustomer(booking, serviceName, staffName);

  const tenantEmail = buildNewBookingForTenant({
    tenantName: booking.tenantName,
    serviceName,
    staffName,
    startsAt: booking.startsAt,
    timezone: booking.timezone,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
  });
  const tenant = await notifyTenant(recipientEmails, recipientsFailed, tenantEmail);

  return { customer, tenant };
}
