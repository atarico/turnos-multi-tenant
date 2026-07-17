import type { BookableService, BookableStaff, BookingLoad, WeeklyAvailability } from "../domain/types";

/**
 * Mapeos row→dominio de las seis vistas públicas anónimas (`public_*`,
 * migration 0004). Funciones PURAS, sin import de Supabase: es el punto
 * exacto que este cambio unit-testea sin mocking, a diferencia de los
 * mapeos inline del camino autenticado en `queries.ts`, soldados a
 * `createClient()`. `public-queries.ts` importa de acá y se queda I/O-only.
 *
 * Los tipos de fila reflejan las columnas de la VISTA, no de la tabla base
 * (ej. `public_staff` no tiene `active`, `public_booking_load` no tiene
 * `status`): la vista ya filtró eso.
 */

export interface PublicServiceRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_cents: number;
  currency: string;
  capacity: number;
}

export interface PublicStaffRow {
  id: string;
  tenant_id: string;
  name: string;
  role: string | null;
  avatar_url: string | null;
}

export interface PublicStaffServiceRow {
  staff_id: string;
  service_id: string;
}

export interface PublicAvailabilityRow {
  staff_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface PublicBookingLoadRow {
  staff_id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
}

export function toPublicService(r: PublicServiceRow): BookableService {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    durationMin: r.duration_min,
    priceCents: r.price_cents,
    currency: r.currency,
    capacity: r.capacity,
  };
}

export function toPublicStaff(r: PublicStaffRow): BookableStaff {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    avatarUrl: r.avatar_url,
  };
}

export function toPublicAvailability(r: PublicAvailabilityRow): WeeklyAvailability {
  return {
    weekday: r.weekday,
    startTime: r.start_time,
    endTime: r.end_time,
  };
}

export function toPublicLoad(r: PublicBookingLoadRow): BookingLoad {
  return {
    serviceId: r.service_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  };
}
