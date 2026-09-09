import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { buildBookingReminder } from "../domain/booking-email";
import { sendEmail } from "./email";

/**
 * Una fila de `bookings_due_for_reminder()`. Espeja su `returns table`.
 *
 * Viene con todo resuelto —negocio, servicio, profesional— porque la función
 * de la base lo trae en una sola consulta. La alternativa era traer ids y
 * resolver nombres uno por uno: tres viajes por turno contra una base que está
 * del otro lado de la red, dentro de un proceso que tiene minutos.
 */
interface DueRow {
  booking_id: string;
  tenant_name: string;
  timezone: string;
  service_name: string;
  staff_name: string | null;
  starts_at: string;
  customer_name: string;
  customer_email: string;
}

/**
 * Cómo terminó la corrida. Es lo único que queda de ella, así que dice las
 * cuatro cosas que alguien querría saber al mirar un log.
 *
 * `notConfigured` y `failedToRead` son banderas y no un estado más porque
 * pueden convivir con números: se puede haber leído bien, mandado tres, y
 * recién ahí descubrir que falta la configuración.
 */
export interface ReminderSummary {
  /** Cuántos turnos tocaban hoy. */
  due: number;
  /** A cuántos les salió el correo Y quedaron marcados. */
  sent: number;
  /** A cuántos les falló el proveedor. Quedan sin marcar. */
  failed: number;
  /** El correo no está configurado: se cortó en el primero y no se marcó a nadie. */
  notConfigured: boolean;
  /** Ni siquiera se pudo leer la lista. */
  failedToRead: boolean;
}

const empty = (over: Partial<ReminderSummary> = {}): ReminderSummary => ({
  due: 0,
  sent: 0,
  failed: 0,
  notConfigured: false,
  failedToRead: false,
  ...over,
});

/**
 * Manda los recordatorios de los turnos de mañana.
 *
 * NUNCA TIRA. Del otro lado hay un endpoint HTTP que llama el cron: una
 * excepción que se escape se convierte en un 500, el cron lo reintenta, y el
 * reintento vuelve a mandar todo lo que ya había salido. Un proceso que le
 * escribe a gente tiene que fallar hacia adentro.
 *
 * EL ORDEN ES EL DISEÑO, igual que en el checkout y en la baja, y acá el par
 * asimétrico es mandar/marcar:
 *
 *   · Marcar DESPUÉS de que el proveedor aceptó, y de a uno. Si el mail falla,
 *     esa fila queda sin marcar y la agarra la corrida siguiente.
 *   · Marcar ANTES, o marcar el lote entero de una, deja gente sin aviso y
 *     marcada como avisada ante cualquier corte. Es el único fallo de este
 *     sistema que después nadie puede detectar: no hay rastro de lo que no se
 *     mandó.
 *
 * Un fallo suelto NO se lleva el lote: si el mail 3 de 40 rebota, los 37 que
 * siguen salen igual. Lo que sí corta es el correo apagado — no tiene sentido
 * recorrer cuatrocientos turnos preguntándole a un módulo que ya contestó que
 * no está configurado, y sobre todo no se marca a nadie: marcar sin mandar
 * dejaría a todos esos clientes sin recordatorio para siempre, en silencio, el
 * día que alguien prenda el correo y crea que ya está andando.
 */
export async function sendDueReminders(): Promise<ReminderSummary> {
  let rows: DueRow[];

  try {
    // El `try` abarca la creación del cliente: `createAdminClient()` revienta
    // si falta la service-role key, y mirar sólo el `error` de PostgREST deja
    // afuera justo ese camino. Mismo aprendizaje que el resto del repo.
    const admin = createAdminClient();
    const due = await admin.rpc("bookings_due_for_reminder", {});

    if (due.error) return empty({ failedToRead: true });
    rows = (due.data ?? []) as DueRow[];
  } catch {
    return empty({ failedToRead: true });
  }

  const summary = empty({ due: rows.length });

  for (const row of rows) {
    const email = buildBookingReminder({
      tenantName: row.tenant_name,
      serviceName: row.service_name,
      staffName: row.staff_name,
      startsAt: new Date(row.starts_at),
      timezone: row.timezone,
      customerName: row.customer_name,
    });

    const sent = await sendEmail({ to: row.customer_email, ...email });

    if (!sent.ok) {
      summary.failed += 1;
      continue;
    }

    if (sent.value === "not_configured") {
      summary.notConfigured = true;
      return summary;
    }

    try {
      const admin = createAdminClient();
      await admin.rpc("mark_booking_reminded", { p_booking_id: row.booking_id });
      summary.sent += 1;
    } catch {
      // El correo YA SALIÓ y la marca no entró: mañana esta persona recibe el
      // recordatorio de nuevo. Es molesto y es el lado correcto en el que
      // equivocarse — la alternativa es que alguien no reciba nada. Se cuenta
      // como fallo para que el número del log no mienta.
      summary.failed += 1;
    }
  }

  return summary;
}
