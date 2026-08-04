"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

import { canTransition, isBookingStatus } from "../domain/booking-transitions";
import type { BookingStatus } from "../domain/types";
import { getBooking } from "./queries";

/**
 * Server Actions del CICLO DE VIDA de un turno: cerrarlo como confirmado,
 * completado, no asistió o cancelado.
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
