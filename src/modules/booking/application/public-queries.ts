import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import type { BookableService, BookableStaff, BookingLoad, WeeklyAvailability } from "../domain/types";
import {
  toPublicAvailability,
  toPublicLoad,
  toPublicService,
  toPublicStaff,
  type PublicAvailabilityRow,
  type PublicBookingLoadRow,
  type PublicServiceRow,
  type PublicStaffRow,
} from "./public-mappers";

/**
 * Consultas de lectura del motor de reservas para la página PÚBLICA (anónima,
 * `/{slug}`). Lee las vistas `public_*` (migration 0004), no las tablas base:
 * ya filtran fila activa y columnas seguras, así que un cliente sin sesión
 * nunca ve más de lo que esta capa expone. Camino DELIBERADAMENTE separado
 * del autenticado en `queries.ts` — no lo tocamos ni lo reutilizamos, ese es
 * el punto de la separación de confianza del diseño.
 */

/** Servicios activos del negocio, ordenados por nombre. */
export async function listPublicServices(
  tenantId: string,
): Promise<Result<BookableService[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_services")
    .select("id, tenant_id, name, description, duration_min, price_cents, currency, capacity")
    .eq("tenant_id", tenantId)
    .order("name");

  if (error) {
    return err(appError("services_query_failed", "No pudimos cargar los servicios."));
  }
  return ok((data as PublicServiceRow[]).map(toPublicService));
}

/** Un servicio puntual del negocio (para conocer duración y cupo). */
export async function getPublicService(
  tenantId: string,
  serviceId: string,
): Promise<Result<BookableService>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_services")
    .select("id, tenant_id, name, description, duration_min, price_cents, currency, capacity")
    .eq("tenant_id", tenantId)
    .eq("id", serviceId)
    .maybeSingle();

  if (error) {
    return err(appError("service_query_failed", "No pudimos cargar el servicio."));
  }
  if (!data) {
    return err(appError("service_not_found", "Ese servicio no está disponible."));
  }
  return ok(toPublicService(data as PublicServiceRow));
}

/**
 * Profesionales activos que ofrecen un servicio dado. `public_staff_services`
 * es una vista sin foreign keys reales, así que PostgREST no puede embeberla
 * con `!inner` como hace el camino autenticado (`staff_services!inner(...)`
 * sobre la tabla base) — se resuelve en dos consultas explícitas.
 */
export async function listPublicStaffForService(
  tenantId: string,
  serviceId: string,
): Promise<Result<BookableStaff[]>> {
  const supabase = await createClient();

  const links = await supabase
    .from("public_staff_services")
    .select("staff_id")
    .eq("service_id", serviceId);

  if (links.error) {
    return err(appError("staff_query_failed", "No pudimos cargar los profesionales."));
  }

  const staffIds = [...new Set(links.data.map((r) => r.staff_id as string))];
  if (staffIds.length === 0) return ok([]);

  const { data, error } = await supabase
    .from("public_staff")
    .select("id, tenant_id, name, role, avatar_url")
    .eq("tenant_id", tenantId)
    .in("id", staffIds)
    .order("name");

  if (error) {
    return err(appError("staff_query_failed", "No pudimos cargar los profesionales."));
  }
  return ok((data as PublicStaffRow[]).map(toPublicStaff));
}

/** Horario semanal recurrente de un profesional activo. */
export async function getPublicStaffAvailability(
  staffId: string,
): Promise<Result<WeeklyAvailability[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_availability")
    .select("staff_id, weekday, start_time, end_time")
    .eq("staff_id", staffId)
    .order("weekday")
    .order("start_time");

  if (error) {
    return err(appError("availability_query_failed", "No pudimos cargar la disponibilidad."));
  }
  return ok((data as PublicAvailabilityRow[]).map(toPublicAvailability));
}

/**
 * Reservas vivas ('pending'/'confirmed', sólo futuras) de un profesional que
 * SOLAPAN un rango [inicio, fin). `public_booking_load` ya filtra
 * `starts_at >= now()`, a diferencia de `bookings` en el camino autenticado.
 */
export async function getPublicBookingLoad(
  staffId: string,
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<Result<BookingLoad[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_booking_load")
    .select("staff_id, service_id, starts_at, ends_at")
    .eq("staff_id", staffId)
    .lt("starts_at", rangeEndIso)
    .gt("ends_at", rangeStartIso);

  if (error) {
    return err(appError("load_query_failed", "No pudimos cargar la agenda del profesional."));
  }
  return ok((data as PublicBookingLoadRow[]).map(toPublicLoad));
}
