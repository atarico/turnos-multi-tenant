"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

import { friendlyOwnerBookingError } from "../domain/booking-errors";
import { resolveDayRange } from "../domain/day-range";
import { bookingSchema } from "../domain/schemas";
import { availableWeekdays, generateSlots } from "../domain/slots";
import type { AvailableSlot, BookableStaff, WeeklyAvailability } from "../domain/types";
import {
  getBookingLoad,
  getService,
  getStaffAvailability,
  listStaffForService,
} from "./queries";

/**
 * Profesionales que ofrecen un servicio. Resuelve el negocio del usuario
 * autenticado en el servidor: NUNCA se confía en un tenant que mande el cliente.
 */
export async function listStaffAction(
  serviceId: string,
): Promise<Result<BookableStaff[]>> {
  const tenant = await getCurrentTenant();
  if (!tenant) return err(appError("no_tenant", "No encontramos tu negocio."));
  return listStaffForService(tenant.id, serviceId);
}

/**
 * Días de la semana con atención + ventanas del profesional. El calendario usa
 * `weekdays` para deshabilitar los días sin disponibilidad.
 */
export async function getAvailabilityAction(
  staffId: string,
): Promise<Result<{ weekdays: number[]; windows: WeeklyAvailability[] }>> {
  const tenant = await getCurrentTenant();
  if (!tenant) return err(appError("no_tenant", "No encontramos tu negocio."));

  const result = await getStaffAvailability(staffId);
  if (!result.ok) return result;

  return ok({
    weekdays: availableWeekdays(result.value),
    windows: result.value,
  });
}

/**
 * Franjas reservables de un profesional para un servicio y una fecha
 * ("YYYY-MM-DD"). Toda la aritmética de tiempo vive en el servidor y en la
 * timezone del negocio; el cliente sólo pinta el resultado.
 */
export async function getSlotsAction(
  serviceId: string,
  staffId: string,
  dateStr: string,
): Promise<Result<AvailableSlot[]>> {
  const tenant = await getCurrentTenant();
  if (!tenant) return err(appError("no_tenant", "No encontramos tu negocio."));

  const dayRange = resolveDayRange(dateStr, tenant.timezone);
  if (!dayRange) return err(appError("bad_date", "Fecha inválida."));

  const serviceResult = await getService(tenant.id, serviceId);
  if (!serviceResult.ok) return serviceResult;
  const service = serviceResult.value;

  const availabilityResult = await getStaffAvailability(staffId);
  if (!availabilityResult.ok) return availabilityResult;

  const loadResult = await getBookingLoad(staffId, dayRange.startIso, dayRange.endIso);
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
 * Crea la reserva vía la RPC `create_booking()`, el único camino válido de
 * inserción (SECURITY DEFINER: valida cupo, disponibilidad y concurrencia con
 * advisory lock). Acá sólo hacemos la primera validación de forma y traducimos
 * el error de la base a un mensaje claro.
 */
export async function createBookingAction(
  input: unknown,
): Promise<ActionState> {
  const parsed = bookingSchema.safeParse(input);
  if (!parsed.success) {
    return errorState("Revisá los datos de la reserva.", zodFieldErrors(parsed.error));
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return errorState("No encontramos tu negocio. Volvé a ingresar.");
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
    return errorState(friendlyOwnerBookingError(error.message));
  }

  // La agenda del panel cambió: que la próxima carga muestre el turno nuevo.
  revalidatePath("/panel");
  return { status: "success", message: "Reserva confirmada." };
}
