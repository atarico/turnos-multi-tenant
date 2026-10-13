import "server-only";

import { z } from "zod";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Lo mínimo de un turno para la página de retorno de Mercado Pago.
 *
 * Va por el cliente admin porque quien llega es anónimo y `bookings` no es
 * legible sin sesión. Por eso el candado está ACÁ: se busca por id Y por
 * negocio (el que resolvió el slug de la URL), así un id de otro negocio —o
 * adivinado— no devuelve nada. Y se piden sólo columnas no personales: ni
 * nombre, ni mail, ni teléfono del cliente.
 */

export interface ReturnBooking {
  id: string;
  status: string;
  paymentStatus: string;
  paymentExpiresAt: string | null;
  serviceName: string;
  startsAt: string;
}

interface Row {
  id: string;
  status: string;
  payment_status: string;
  payment_expires_at: string | null;
  service_name: string;
  starts_at: string;
}

const idSchema = z.uuid();

export async function getBookingForReturn(
  tenantId: string,
  bookingId: string,
): Promise<Result<ReturnBooking | null>> {
  // Un id mal formado no existe: se corta antes de tocar la base.
  if (!idSchema.safeParse(bookingId).success) return ok(null);

  try {
    const { data, error } = await createAdminClient()
      .from("bookings")
      .select("id, status, payment_status, payment_expires_at, service_name, starts_at")
      .eq("id", bookingId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return ok(null);

    const row = data as Row;
    return ok({
      id: row.id,
      status: row.status,
      paymentStatus: row.payment_status,
      paymentExpiresAt: row.payment_expires_at,
      serviceName: row.service_name,
      startsAt: row.starts_at,
    });
  } catch {
    return err(appError("booking_load_failed", "No pudimos consultar el turno."));
  }
}
