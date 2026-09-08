import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { buildBookingConfirmation } from "../domain/booking-email";
import { sendEmail } from "./email";

/**
 * Lo que el aviso necesita saber de la reserva recién tomada.
 *
 * Llegan los IDS del servicio y del profesional, no los nombres: quien llama
 * acaba de crear la reserva y tiene la fila, no el catálogo. Resolverlos es
 * trabajo de acá.
 */
export interface BookingCreated {
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
 * Cómo terminó el aviso. Los cuatro se reportan, ninguno tira.
 *
 * `no_email` es el más frecuente y NO es un problema: el campo es opcional y
 * la mayoría de las reservas no lo trae. `not_configured` es el estado
 * mientras no exista la cuenta del proveedor. Sólo `failed` merece que alguien
 * lo mire.
 */
export type NotifyOutcome = "sent" | "no_email" | "not_configured" | "failed";

/**
 * Le avisa por mail a quien acaba de reservar.
 *
 * NUNCA TIRA Y NUNCA DEVUELVE UN ERROR QUE FRENE ALGO, y esa es la razón de
 * que devuelva un texto en vez de un `Result`: cuando esto corre, el turno YA
 * ESTÁ TOMADO y confirmado en la base. No hay nada que revertir y no hay nada
 * que reintentar del lado del cliente. Quien llama no puede hacer NADA con un
 * fallo de acá salvo registrarlo, y un `Result` invitaría a tratarlo como si
 * pudiera.
 *
 * El orden es al revés que en el checkout, y por el mismo razonamiento: allá
 * el efecto externo va ANTES de escribir, porque escribir primero deja una
 * fila mintiendo. Acá el efecto externo va DESPUÉS, porque la reserva es lo
 * único que importa y el mail es su accesorio. Invertirlo —no confirmar el
 * turno hasta que el mail salga— le regalaría a un proveedor de correo el
 * poder de rechazar reservas.
 *
 * SIN PROFESIONAL SE MANDA IGUAL; SIN SERVICIO NO. No es una asimetría
 * caprichosa: el servicio es el "qué" del turno y un mail que confirma algo
 * sin decir qué es peor que ninguno, mientras que el profesional puede
 * legítimamente no estar asignado.
 */
export async function notifyBookingCreated(
  booking: BookingCreated,
): Promise<NotifyOutcome> {
  if (!booking.customerEmail) return "no_email";

  let serviceName: string | null = null;
  let staffName: string | null = null;

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
  } catch {
    return "failed";
  }

  if (!serviceName) return "failed";

  const email = buildBookingConfirmation({
    tenantName: booking.tenantName,
    serviceName,
    staffName,
    startsAt: booking.startsAt,
    timezone: booking.timezone,
    customerName: booking.customerName,
  });

  const sent = await sendEmail({ to: booking.customerEmail, ...email });

  if (!sent.ok) return "failed";
  return sent.value === "not_configured" ? "not_configured" : "sent";
}
