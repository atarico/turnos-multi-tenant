"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

import { friendlyRescheduleError } from "../domain/booking-errors";
import {
  canReschedule,
  canTransition,
  canTransitionAt,
  isBookingStatus,
} from "../domain/booking-transitions";
import type { BookingStatus } from "../domain/types";
import { getBooking } from "./queries";

/**
 * Server Actions del CICLO DE VIDA de un turno: cerrarlo (confirmado,
 * completado, no asistió, cancelado) y moverlo en el tiempo.
 *
 * Viven separadas de `actions.ts` (que crea turnos) porque son la otra mitad
 * del ciclo y comparten guards propios: siempre releen el turno desde la base
 * antes de tocarlo. El `id` llega del cliente, así que NUNCA se confía ni en el
 * turno ni en su estado tal como vengan en el formulario.
 */

/** Mensaje de éxito según el desenlace, en pasado: ya ocurrió. */
const DONE_MESSAGES: Record<BookingStatus, string> = {
  pending: "Turno marcado como pendiente.",
  confirmed: "Turno confirmado.",
  cancelled: "Turno cancelado.",
  completed: "Turno marcado como completado.",
  no_show: "Turno marcado como no asistido.",
};

/** Refresca el panel y la página pública (una cancelación libera la franja). */
function revalidateAgenda(slug: string) {
  revalidatePath("/panel");
  revalidatePath(`/${slug}`);
}

/**
 * Mueve un turno a otro estado del ciclo de vida.
 *
 * El estado ACTUAL se relee de la base, no se acepta del formulario: entre que
 * la agenda se pintó y el dueño hizo clic, el turno pudo cambiar. Validar
 * contra lo que el cliente cree que hay permitiría reabrir un turno cerrado
 * mandando el estado viejo.
 */
export async function updateBookingStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return errorState("No pudimos identificar el turno.");

  const nextStatus = String(formData.get("status") ?? "").trim();
  if (!isBookingStatus(nextStatus)) {
    return errorState("Ese estado no existe.");
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const current = await getBooking(tenant.id, id);
  if (!current.ok) return errorState(current.error.message);

  if (!canTransition(current.value.status, nextStatus)) {
    return errorState(
      "Ese turno ya está cerrado o no admite ese cambio. Recargá la agenda.",
    );
  }

  // El estado destino pasa el filtro de estado pero no el del reloj: cerrar un
  // turno es contar lo que pasó en la silla, y todavía no pasó. Mensaje aparte
  // del de arriba porque la salida es otra — acá no hay que recargar nada, hay
  // que esperar. `ends_at` también se relee de la base: el horario del turno es
  // tan poco confiable como su estado si viene del formulario.
  if (
    !canTransitionAt(current.value.status, nextStatus, current.value.endsAt)
  ) {
    return errorState(
      "Ese turno todavía no terminó: vas a poder cerrarlo cuando pase su horario.",
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("bookings")
    .update({ status: nextStatus })
    .eq("id", id)
    .eq("tenant_id", tenant.id);

  if (error) {
    return errorState("No pudimos cambiar el estado del turno. Intentá de nuevo.");
  }

  revalidateAgenda(tenant.slug);
  return { status: "success", message: DONE_MESSAGES[nextStatus] };
}

/**
 * Reprograma un turno vía la RPC `reschedule_booking()`, único camino válido:
 * mover un turno revalida disponibilidad, solape y cupo con advisory lock, tal
 * como al crearlo. Un UPDATE suelto desde acá permitiría doble-booking.
 *
 * El chequeo de `canReschedule` es un corte temprano con mensaje claro; la
 * validación autoritativa (incluida la carrera contra otra reserva) la sigue
 * haciendo la base.
 */
export async function rescheduleBookingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return errorState("No pudimos identificar el turno.");

  const startsAt = String(formData.get("startsAt") ?? "").trim();
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
    return errorState("Elegí una franja válida para mover el turno.");
  }

  // Vacío = se queda con el profesional que ya tenía.
  const staffId = String(formData.get("staffId") ?? "").trim();

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const current = await getBooking(tenant.id, id);
  if (!current.ok) return errorState(current.error.message);

  if (!canReschedule(current.value.status)) {
    return errorState("Ese turno ya está cerrado: no se puede reprogramar.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reschedule_booking", {
    p_booking_id: id,
    p_starts_at: startsAt,
    p_staff_id: staffId ? staffId : null,
  });

  if (error) {
    return errorState(friendlyRescheduleError(error.message));
  }

  revalidateAgenda(tenant.slug);
  return { status: "success", message: "Turno reprogramado." };
}
