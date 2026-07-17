"use server";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";
import { getTenantBySlug } from "@/modules/tenants/application/queries";

import { friendlyBookingError } from "../domain/booking-errors";
import { resolveDayRange } from "../domain/day-range";
import { bookingSchema } from "../domain/schemas";
import { availableWeekdays, generateSlots } from "../domain/slots";
import type { AvailableSlot, BookableStaff, WeeklyAvailability } from "../domain/types";
import {
  getPublicBookingLoad,
  getPublicService,
  getPublicStaffAvailability,
  listPublicStaffForService,
  staffBelongsToTenant,
} from "./public-queries";

/**
 * Server Actions de la página PÚBLICA (anónima) `/{slug}`. No hay sesión de
 * la que derivar el tenant: el slug ES el input, así que cada acción lo
 * recibe explícito y re-resuelve `getTenantBySlug(slug)`. Seguro porque las
 * vistas `public_*` sólo exponen filas no sensibles y `create_booking()` es
 * SECURITY DEFINER: revalida tenant/servicio/staff/disponibilidad/solape/
 * cupo en la base sin importar qué mande el cliente. Un cliente hostil que
 * cambie el slug sólo gana lo que ya podía leer en `/{ese-otro-slug}`.
 *
 * Camino DELIBERADAMENTE separado de `actions.ts` (panel, autenticado):
 * comparten sólo el dominio puro (`domain/slots.ts`, `domain/day-range.ts`).
 */

const TENANT_NOT_FOUND = appError("tenant_not_found", "No encontramos ese negocio.");
const STAFF_NOT_FOUND = appError("staff_not_found", "Ese profesional no está disponible.");

/**
 * Ancla de aislamiento cross-tenant: el `staffId` llega del cliente, así que
 * antes de leer su agenda hay que confirmar que pertenece al negocio resuelto
 * por slug. En el flujo normal el id sale de `listPublicStaffForService`
 * (ya scopeado), pero una Server Action es invocable directo con un id ajeno.
 */
async function assertStaffInTenant(
  tenantId: string,
  staffId: string,
): Promise<Result<void>> {
  const belongs = await staffBelongsToTenant(tenantId, staffId);
  if (!belongs.ok) return belongs;
  if (!belongs.value) return err(STAFF_NOT_FOUND);
  return ok(undefined);
}

/** Profesionales que ofrecen un servicio, para el negocio resuelto por slug. */
export async function listPublicStaffAction(
  slug: string,
  serviceId: string,
): Promise<Result<BookableStaff[]>> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return err(TENANT_NOT_FOUND);
  return listPublicStaffForService(tenant.id, serviceId);
}

/**
 * Días de la semana con atención + ventanas del profesional. El calendario
 * público usa `weekdays` para deshabilitar los días sin disponibilidad.
 */
export async function getPublicAvailabilityAction(
  slug: string,
  staffId: string,
): Promise<Result<{ weekdays: number[]; windows: WeeklyAvailability[] }>> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return err(TENANT_NOT_FOUND);

  const staffCheck = await assertStaffInTenant(tenant.id, staffId);
  if (!staffCheck.ok) return staffCheck;

  const result = await getPublicStaffAvailability(staffId);
  if (!result.ok) return result;

  return ok({
    weekdays: availableWeekdays(result.value),
    windows: result.value,
  });
}

/**
 * Franjas reservables de un profesional para un servicio y una fecha
 * ("YYYY-MM-DD"). Usa `resolveDayRange` — la MISMA aritmética que el camino
 * autenticado (`getSlotsAction`): duplicarla a mano sería justo el tipo de
 * divergencia que un bug de DST aprovecha.
 */
export async function getPublicSlotsAction(
  slug: string,
  serviceId: string,
  staffId: string,
  dateStr: string,
): Promise<Result<AvailableSlot[]>> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return err(TENANT_NOT_FOUND);

  const staffCheck = await assertStaffInTenant(tenant.id, staffId);
  if (!staffCheck.ok) return staffCheck;

  const dayRange = resolveDayRange(dateStr, tenant.timezone);
  if (!dayRange) return err(appError("bad_date", "Fecha inválida."));

  const serviceResult = await getPublicService(tenant.id, serviceId);
  if (!serviceResult.ok) return serviceResult;
  const service = serviceResult.value;

  const availabilityResult = await getPublicStaffAvailability(staffId);
  if (!availabilityResult.ok) return availabilityResult;

  const loadResult = await getPublicBookingLoad(staffId, dayRange.startIso, dayRange.endIso);
  if (!loadResult.ok) return loadResult;

  const slots = generateSlots({
    date: dayRange.date,
    timezone: tenant.timezone,
    serviceId,
    durationMin: service.durationMin,
    capacity: service.capacity,
    windows: availabilityResult.value,
    load: loadResult.value,
    now: new Date(),
  });

  return ok(slots);
}

/**
 * Crea la reserva del visitante anónimo vía la RPC `create_booking()`, el
 * único camino válido de inserción. Sin sesión que validar: el slug identifica
 * el negocio y la RPC (SECURITY DEFINER) revalida todo del lado del servidor.
 */
export async function createPublicBookingAction(
  slug: string,
  input: unknown,
): Promise<ActionState> {
  const parsed = bookingSchema.safeParse(input);
  if (!parsed.success) {
    return errorState("Revisá los datos de la reserva.", zodFieldErrors(parsed.error));
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return errorState("No encontramos ese negocio.");
  }

  const {
    service_id,
    staff_id,
    starts_at,
    customer_name,
    customer_email,
    customer_phone,
  } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_booking", {
    p_tenant_slug: tenant.slug,
    p_staff_id: staff_id,
    p_service_id: service_id,
    p_starts_at: starts_at,
    p_customer_name: customer_name,
    p_customer_email: customer_email ? customer_email : null,
    p_customer_phone: customer_phone ? customer_phone : null,
  });

  if (error) {
    return errorState(friendlyBookingError(error.message));
  }

  return { status: "success", message: "Reserva confirmada." };
}
