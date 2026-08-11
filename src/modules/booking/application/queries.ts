import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import { resolveMonthRange } from "../domain/day-range";
import type {
  AgendaBooking,
  BookableService,
  BookableStaff,
  BookingDetail,
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
  // Foto congelada al crear el turno (`snapshot_booking_names()`), no el
  // nombre vivo de `services`/`staff` — por eso NUNCA se lee vía embed ni
  // se le pone un fallback: la columna es NOT NULL desde el origen.
  service_name: string;
  staff_name: string;
}

interface BookingDetailRow extends AgendaBookingRow {
  // Nullable: el turno puede seguir 'cancelled'/'no_show' con su servicio o
  // profesional ya borrado — el CHECK sólo exige el vínculo mientras vive.
  service_id: string | null;
  staff_id: string | null;
}

/**
 * Estados que ocupan la agenda. Fuente única: el motor los usa para contar cupo
 * (`create_booking`, `reschedule_booking`), y acá para decidir qué turnos siguen
 * pidiendo una decisión del negocio.
 */
const LIVE_STATUSES: BookingStatus[] = ["pending", "confirmed"];

/**
 * Columnas del turno tal como las pinta la agenda. Lee `service_name`/
 * `staff_name` — la foto congelada en la fila — en vez de embeber
 * `services(name)`/`staff(name)`: esos joins devolverían `null` para un
 * turno con el servicio o profesional ya borrado, y un rename retroactivo
 * reescribiría el historial si se leyera el nombre vivo.
 */
const AGENDA_COLUMNS =
  "id, customer_name, customer_phone, starts_at, ends_at, status, service_name, staff_name";

const toAgendaBooking = (r: AgendaBookingRow): AgendaBooking => ({
  id: r.id,
  customerName: r.customer_name,
  customerPhone: r.customer_phone,
  serviceName: r.service_name,
  staffName: r.staff_name,
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
    .select(AGENDA_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("status", LIVE_STATUSES)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at");

  if (error) {
    return err(appError("bookings_query_failed", "No pudimos cargar los turnos."));
  }
  return ok((data as unknown as AgendaBookingRow[]).map(toAgendaBooking));
}

/**
 * Turnos VENCIDOS que siguen vivos: ya terminaron pero nadie dijo si el cliente
 * vino, no vino, o si se canceló.
 *
 * Existen porque la agenda de próximos turnos filtra `starts_at >= now()`: al
 * pasar la hora, el turno desaparecía de la vista y su estado quedaba congelado
 * en 'confirmed' para siempre. Sin esta lista el ciclo de vida no cierra nunca.
 *
 * Van del más reciente al más viejo: lo primero que el dueño quiere cerrar es
 * lo que acaba de pasar.
 */
export async function listBookingsToClose(
  tenantId: string,
): Promise<Result<AgendaBooking[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(AGENDA_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("status", LIVE_STATUSES)
    .lt("ends_at", new Date().toISOString())
    .order("starts_at", { ascending: false });

  if (error) {
    return err(
      appError("bookings_query_failed", "No pudimos cargar los turnos a cerrar."),
    );
  }
  return ok((data as unknown as AgendaBookingRow[]).map(toAgendaBooking));
}

/**
 * Un turno del negocio con las referencias necesarias para operarlo.
 *
 * El `tenant_id` explícito NO es redundante con la RLS: es el guard que hace
 * que un id ajeno adivinado devuelva "no existe" en vez de filtrar datos.
 */
export async function getBooking(
  tenantId: string,
  bookingId: string,
): Promise<Result<BookingDetail>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(`${AGENDA_COLUMNS}, service_id, staff_id`)
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .maybeSingle();

  if (error) {
    return err(appError("booking_query_failed", "No pudimos cargar el turno."));
  }
  if (!data) {
    return err(appError("booking_not_found", "No encontramos ese turno."));
  }

  const row = data as unknown as BookingDetailRow;
  return ok({
    ...toAgendaBooking(row),
    serviceId: row.service_id,
    staffId: row.staff_id,
  });
}

/** Total cobrado en un mes, con la moneda en la que se cobró. */
export interface MonthlyRevenue {
  totalCents: number;
  currency: string;
}

/**
 * Moneda a mostrar cuando el mes no tuvo un solo turno cerrado: sin filas no
 * hay de dónde leerla. Coincide con el default de `services.currency`, que es
 * lo único que puede haber hoy — la UI del catálogo no expone el campo.
 */
const FALLBACK_CURRENCY = "ARS";

/**
 * Ingresos del mes: suma del precio CONGELADO de los turnos completados.
 *
 * Dos decisiones que valen más que el código:
 *
 * 1. **Sólo `completed`.** Es lo que efectivamente se cobró. Un turno
 *    confirmado todavía puede cancelarse, y contarlo sería vender plata que no
 *    entró. Además cierra el círculo con "Turnos a cerrar": si el dueño no
 *    cierra sus turnos, no ve ingresos.
 * 2. **`price_cents` de la fila, no de `services`.** El precio del turno es un
 *    hecho del pasado. Leerlo del catálogo hacía que subir la lista de precios
 *    revaluara meses ya cerrados.
 *
 * La ventana es el mes civil del NEGOCIO (ver `resolveMonthRange`): un turno
 * del 30 de septiembre a las 23:00 en Buenos Aires cae en octubre si se filtra
 * por UTC.
 *
 * La suma la hace Postgres (`sum_monthly_revenue`), no esta función: traer las
 * filas y sumarlas acá se rompía contra el `max_rows` de PostgREST, que recorta
 * la respuesta en 1000 filas SIN devolver error. Un mes con más turnos
 * completados que ese tope habría mostrado menos plata de la real, en silencio.
 *
 * El RPC devuelve una fila por moneda. Con más de una no hay total posible:
 * sumar pesos con dólares no da un número, da un invento. En ese caso falla y
 * el panel muestra "—".
 */
export async function sumMonthlyRevenue(
  tenantId: string,
  monthStr: string,
  timezone: string,
): Promise<Result<MonthlyRevenue>> {
  const range = resolveMonthRange(monthStr, timezone);
  if (!range) {
    return err(appError("invalid_month", "No pudimos resolver el mes."));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sum_monthly_revenue", {
    p_tenant_id: tenantId,
    p_start: range.startIso,
    p_end: range.endIso,
  });

  if (error || !data) {
    return err(appError("revenue_query_failed", "No pudimos calcular los ingresos."));
  }

  const rows = data as { total_cents: number; currency: string }[];
  if (rows.length > 1) {
    return err(
      appError("mixed_currencies", "Hay turnos en más de una moneda este mes."),
    );
  }

  // Sin turnos cerrados no vuelve ninguna fila: el mes vale cero.
  return ok({
    totalCents: rows[0]?.total_cents ?? 0,
    currency: rows[0]?.currency ?? FALLBACK_CURRENCY,
  });
}

/**
 * Reservas vivas ('pending'/'confirmed') de un profesional que SOLAPAN un
 * rango [inicio, fin). Se usa el solape real (no sólo `starts_at` dentro del
 * día) para no perder una reserva que arranca antes de la medianoche del día.
 *
 * `service_id` no es nullable acá pese a serlo en la tabla: el CHECK
 * `bookings_service_link_or_terminal` garantiza el vínculo mientras el turno
 * siga en `LIVE_STATUSES`, que es exactamente el filtro de esta consulta.
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
    .in("status", LIVE_STATUSES)
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
