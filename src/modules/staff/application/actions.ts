"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import type { Tenant } from "@/modules/tenants/domain/types";

import { buildWeeklySchedule } from "../domain/schedule";
import { staffFormSchema } from "../domain/schemas";
import { getStaffMember } from "./queries";

/**
 * Server Actions de profesionales.
 *
 * Alcanzables por POST directo, no sólo desde la UI: todas resuelven el negocio
 * con `getCurrentTenant()` y filtran por `tenant_id`. Nunca se confía en un
 * tenant que venga del cliente.
 */

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** Refresca panel, profesionales y la página pública del negocio. */
function revalidateStaff(tenant: Tenant) {
  revalidatePath("/panel");
  revalidatePath("/panel/profesionales");
  revalidatePath(`/${tenant.slug}`);
}

/**
 * Deja `staff_services` igual a `serviceIds`.
 *
 * Primero inserta lo que falta y recién después borra lo que sobra: si el
 * segundo paso falla, el profesional queda ofreciendo algún servicio de más
 * (molesto) en vez de quedarse sin ninguno (invisible para quien reserva).
 */
async function syncStaffServices(
  supabase: SupabaseClient,
  staffId: string,
  serviceIds: string[],
): Promise<boolean> {
  if (serviceIds.length > 0) {
    const { error } = await supabase.from("staff_services").upsert(
      serviceIds.map((serviceId) => ({ staff_id: staffId, service_id: serviceId })),
      { onConflict: "staff_id,service_id", ignoreDuplicates: true },
    );
    if (error) return false;
  }

  const removal = supabase.from("staff_services").delete().eq("staff_id", staffId);
  const { error } = await (serviceIds.length > 0
    ? removal.not("service_id", "in", `(${serviceIds.join(",")})`)
    : removal);

  return !error;
}

/**
 * Verifica que TODOS los servicios elegidos sean del negocio.
 *
 * No es paranoia: la policy de `staff_services` sólo mira que el `staff_id` sea
 * mío, no el `service_id`. Sin este chequeo, un POST armado a mano podría
 * colgarle a mi profesional un servicio de otro negocio.
 */
async function servicesBelongToTenant(
  supabase: SupabaseClient,
  tenantId: string,
  serviceIds: string[],
): Promise<boolean> {
  if (serviceIds.length === 0) return true;

  const { count, error } = await supabase
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .in("id", serviceIds);

  return !error && count === serviceIds.length;
}

/**
 * Alta o edición de un profesional, según venga o no `id` en el formulario.
 * Incluye la asignación de servicios, que va en la misma pantalla porque un
 * profesional sin servicios no existe para quien reserva.
 */
export async function saveStaffAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = staffFormSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    role: String(formData.get("role") ?? ""),
    serviceIds: formData.getAll("serviceIds").map(String),
  });

  if (!parsed.success) {
    return errorState(
      "Revisá los datos del profesional.",
      zodFieldErrors(parsed.error),
    );
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const supabase = await createClient();
  const { name, role, serviceIds } = parsed.data;

  if (!(await servicesBelongToTenant(supabase, tenant.id, serviceIds))) {
    return errorState("Alguno de los servicios elegidos no es de tu negocio.");
  }

  const id = String(formData.get("id") ?? "").trim();
  let staffId = id;

  if (id) {
    const { error } = await supabase
      .from("staff")
      .update({ name, role })
      .eq("id", id)
      .eq("tenant_id", tenant.id);
    if (error) {
      return errorState("No pudimos guardar los cambios. Intentá de nuevo.");
    }
  } else {
    const { data, error } = await supabase
      .from("staff")
      .insert({ name, role, tenant_id: tenant.id })
      .select("id")
      .single();
    if (error || !data) {
      return errorState("No pudimos agregar al profesional. Intentá de nuevo.");
    }
    staffId = data.id;
  }

  if (!(await syncStaffServices(supabase, staffId, serviceIds))) {
    return errorState(
      "Guardamos al profesional, pero no pudimos actualizar sus servicios.",
    );
  }

  revalidateStaff(tenant);
  return {
    status: "success",
    message: id ? "Profesional actualizado." : "Profesional agregado.",
  };
}

/**
 * Activa o pausa un profesional. Pausar lo saca de la página pública sin tocar
 * los turnos que ya tiene agendados.
 */
export async function toggleStaffActiveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return errorState("No pudimos identificar al profesional.");

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const active = String(formData.get("active") ?? "") === "true";

  const supabase = await createClient();
  const { error } = await supabase
    .from("staff")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenant.id);

  if (error) {
    return errorState("No pudimos cambiar el estado del profesional.");
  }

  revalidateStaff(tenant);
  return {
    status: "success",
    message: active ? "Profesional activado." : "Profesional pausado.",
  };
}

/**
 * Baja definitiva de un profesional.
 *
 * OJO con la FK: `bookings.staff_id` es `on delete cascade`, así que borrar al
 * profesional se llevaría puesto su historial de turnos SIN avisar. Por eso el
 * borrado se frena acá, en la aplicación, cuando tiene turnos: la base no lo
 * va a frenar por nosotros.
 */
export async function deleteStaffAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return errorState("No pudimos identificar al profesional.");

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const supabase = await createClient();
  const { count, error: countError } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("staff_id", id)
    .eq("tenant_id", tenant.id);

  if (countError) {
    return errorState("No pudimos verificar los turnos del profesional.");
  }
  if ((count ?? 0) > 0) {
    return errorState(
      "Este profesional ya tiene turnos, así que no se puede eliminar sin perderlos. Pausalo para dejar de ofrecerlo.",
    );
  }

  const { error } = await supabase
    .from("staff")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenant.id);

  if (error) {
    return errorState("No pudimos eliminar al profesional. Intentá de nuevo.");
  }

  revalidateStaff(tenant);
  return { status: "success", message: "Profesional eliminado." };
}

/**
 * Guarda el horario semanal completo de un profesional.
 *
 * Se reemplaza la semana entera (borrar + insertar) en vez de reconciliar
 * franja por franja: las filas de `staff_availability` no tienen identidad
 * estable para el usuario — nadie edita "la franja 3", edita "el horario".
 *
 * El hueco conocido: entre el DELETE y el INSERT el profesional queda un
 * instante sin horario, y si el INSERT falla se queda sin él. Se avisa con un
 * mensaje explícito en vez de fingir que no pasó. La solución definitiva es una
 * función SECURITY DEFINER que haga las dos cosas en una transacción, como
 * `create_booking`; queda anotado para cuando duela.
 */
export async function saveScheduleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const staffId = String(formData.get("staffId") ?? "").trim();
  if (!staffId) return errorState("No pudimos identificar al profesional.");

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  // Guard de aislamiento: el staffId viene del cliente.
  const member = await getStaffMember(tenant.id, staffId);
  if (!member.ok) return errorState(member.error.message);

  const weekdays = formData.getAll("weekday").map(String);
  const starts = formData.getAll("startTime").map(String);
  const ends = formData.getAll("endTime").map(String);

  if (weekdays.length !== starts.length || weekdays.length !== ends.length) {
    return errorState("El horario llegó incompleto. Volvé a intentar.");
  }

  const schedule = buildWeeklySchedule(
    weekdays.map((weekday, i) => ({
      weekday,
      startTime: starts[i],
      endTime: ends[i],
    })),
  );
  if (!schedule.ok) return errorState(schedule.error.message);

  const supabase = await createClient();
  const { error: deleteError } = await supabase
    .from("staff_availability")
    .delete()
    .eq("staff_id", staffId);

  if (deleteError) {
    return errorState("No pudimos actualizar el horario. Intentá de nuevo.");
  }

  if (schedule.value.length > 0) {
    const { error: insertError } = await supabase.from("staff_availability").insert(
      schedule.value.map((w) => ({
        staff_id: staffId,
        weekday: w.weekday,
        start_time: w.startTime,
        end_time: w.endTime,
      })),
    );

    if (insertError) {
      return errorState(
        "Borramos el horario anterior pero no pudimos guardar el nuevo. Cargalo de nuevo.",
      );
    }
  }

  revalidateStaff(tenant);
  revalidatePath(`/panel/profesionales/${staffId}/horarios`);
  return { status: "success", message: "Horario guardado." };
}
