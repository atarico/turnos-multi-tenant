import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import type {
  AgendaBooking,
  BookableService,
  BookableStaff,
  BookingLoad,
  BookingStatus,
  WeeklyAvailability,
} from "../domain/types";

/**
 * Consultas de lectura del motor de reservas para el PANEL (autenticado).
 *
 * El dueño ya pasó el guard del layout, así que leemos las tablas base: la RLS
 * (`auth_tenant_ids()`) ya limita las filas a su negocio. Aun así filtramos por
 * `tenant_id` explícito como defensa en profundidad. Todo devuelve Result, como
 * el resto de la capa de aplicación.
 */

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_cents: number;
  currency: string;
  capacity: number;
}

interface StaffRow {
  id: string;
  name: string;
  role: string | null;
  avatar_url: string | null;
}

interface AvailabilityRow {
  weekday: number;
  start_time: string;
  end_time: string;
}

interface BookingRow {
  service_id: string;
  starts_at: string;
  ends_at: string;
}

const toService = (r: ServiceRow): BookableService => ({
  id: r.id,
  name: r.name,
  description: r.description,
  durationMin: r.duration_min,
  priceCents: r.price_cents,
  currency: r.currency,
  capacity: r.capacity,
});

const toStaff = (r: StaffRow): BookableStaff => ({
  id: r.id,
  name: r.name,
  role: r.role,
  avatarUrl: r.avatar_url,
});

/** Servicios activos del negocio, ordenados por nombre. */
export async function listServices(
  tenantId: string,
): Promise<Result<BookableService[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, name, description, duration_min, price_cents, currency, capacity")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("name");

  if (error) {
    return err(appError("services_query_failed", "No pudimos cargar los servicios."));
  }
  return ok((data as ServiceRow[]).map(toService));
}

/** Un servicio puntual del negocio (para conocer duración y cupo). */
export async function getService(
  tenantId: string,
  serviceId: string,
): Promise<Result<BookableService>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, name, description, duration_min, price_cents, currency, capacity")
    .eq("tenant_id", tenantId)
    .eq("id", serviceId)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    return err(appError("service_query_failed", "No pudimos cargar el servicio."));
  }
  if (!data) {
    return err(appError("service_not_found", "Ese servicio no está disponible."));
  }
  return ok(toService(data as ServiceRow));
}

/**
 * Profesionales activos que ofrecen un servicio dado. El join `!inner` con
 * `staff_services` deja sólo el staff que efectivamente presta ese servicio.
 */
export async function listStaffForService(
  tenantId: string,
  serviceId: string,
): Promise<Result<BookableStaff[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, name, role, avatar_url, staff_services!inner(service_id)")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .eq("staff_services.service_id", serviceId)
    .order("name");

  if (error) {
    return err(appError("staff_query_failed", "No pudimos cargar los profesionales."));
  }
  return ok((data as StaffRow[]).map(toStaff));
}

/** Horario semanal recurrente de un profesional. */
export async function getStaffAvailability(
  staffId: string,
): Promise<Result<WeeklyAvailability[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_availability")
    .select("weekday, start_time, end_time")
    .eq("staff_id", staffId)
    .order("weekday")
    .order("start_time");

  if (error) {
    return err(appError("availability_query_failed", "No pudimos cargar la disponibilidad."));
  }
  return ok(
    (data as AvailabilityRow[]).map((r) => ({
      weekday: r.weekday,
      startTime: r.start_time,
      endTime: r.end_time,
    })),
  );
}

interface AgendaBookingRow {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  // Embeds a-uno vía las FK de bookings; PostgREST los devuelve como objeto.
  services: { name: string } | null;
  staff: { name: string } | null;
}

const toAgendaBooking = (r: AgendaBookingRow): AgendaBooking => ({
  id: r.id,
  customerName: r.customer_name,
  customerPhone: r.customer_phone,
  serviceName: r.services?.name ?? "—",
  staffName: r.staff?.name ?? "—",
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  status: r.status,
});

/**
 * Próximos turnos del negocio: 'pending'/'confirmed' desde ahora, del más
 * cercano al más lejano. Embebe el nombre de servicio y profesional en la
 * misma consulta para pintar la agenda sin N+1.
 */
export async function listUpcomingBookings(
  tenantId: string,
): Promise<Result<AgendaBooking[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, customer_name, customer_phone, starts_at, ends_at, status, services(name), staff(name)",
    )
    .eq("tenant_id", tenantId)
    .in("status", ["pending", "confirmed"])
    .gte("starts_at", new Date().toISOString())
    .order("starts_at");

  if (error) {
    return err(appError("bookings_query_failed", "No pudimos cargar los turnos."));
  }
  return ok((data as unknown as AgendaBookingRow[]).map(toAgendaBooking));
}

/**
 * Reservas vivas ('pending'/'confirmed') de un profesional que SOLAPAN un
 * rango [inicio, fin). Se usa el solape real (no sólo `starts_at` dentro del
 * día) para no perder una reserva que arranca antes de la medianoche del día.
 */
export async function getBookingLoad(
  staffId: string,
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<Result<BookingLoad[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select("service_id, starts_at, ends_at")
    .eq("staff_id", staffId)
    .in("status", ["pending", "confirmed"])
    .lt("starts_at", rangeEndIso)
    .gt("ends_at", rangeStartIso);

  if (error) {
    return err(appError("load_query_failed", "No pudimos cargar la agenda del profesional."));
  }
  return ok(
    (data as BookingRow[]).map((r) => ({
      serviceId: r.service_id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
    })),
  );
}
