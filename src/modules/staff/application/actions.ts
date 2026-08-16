"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { wroteRows } from "@/core/db-write";
import { createClient } from "@/lib/supabase/server";
import { hasRoomForStaff, limitsFor } from "@/modules/billing/domain/plan";
import { deleteBlockMessage } from "@/modules/booking/domain/delete-outcome";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import type { Tenant } from "@/modules/tenants/domain/types";

import { buildWeeklySchedule } from "../domain/schedule";
import { staffFormSchema } from "../domain/schemas";
import { countActiveStaff, getStaffMember } from "./queries";

/**
 * Server Actions de profesionales.
 *
 * Alcanzables por POST directo, no sólo desde la UI: todas resuelven el negocio
 * con `getCurrentTenant()` y filtran por `tenant_id`. Nunca se confía en un
 * tenant que venga del cliente.
 */

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** Código de violación de foreign key en Postgres. */
const FOREIGN_KEY_VIOLATION = "23503";

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

  const id = String(formData.get("id") ?? "").trim();

  /**
   * El cupo del plan se chequea SÓLO en el alta, y antes de tocar la base.
   *
   * En la edición no va, y no es un olvido: un negocio que bajó de plan queda
   * por encima del cupo, y si el guard también corriera acá no podría ni
   * corregirle el nombre a alguien que ya tiene cargado. Lo que se ocupa se
   * congela; no se borra ni se bloquea. Ver `billing/domain/plan.ts`.
   */
  if (!id) {
    const active = await countActiveStaff(tenant.id);
    if (!active.ok) return errorState(active.error.message);

    if (!hasRoomForStaff(tenant.plan, active.value)) {
      return errorState(
        `Tu plan permite hasta ${limitsFor(tenant.plan).staff} profesionales activos. Pausá uno que no estés usando, o pasá a un plan más grande para sumar otro.`,
      );
    }
  }

  const supabase = await createClient();
  const { name, role, serviceIds } = parsed.data;

  if (!(await servicesBelongToTenant(supabase, tenant.id, serviceIds))) {
    return errorState("Alguno de los servicios elegidos no es de tu negocio.");
  }

  let staffId = id;

  if (id) {
    // Pide la fila de vuelta y cuenta lo que tocó: `error: null` con cero filas
    // es un fallo silencioso, no un guardado. Ver `core/db-write.ts`.
    const written = await supabase
      .from("staff")
      .update({ name, role })
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .select("id");
    if (!wroteRows(written)) {
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

  // Un profesional recién creado todavía no ofrece un solo turno: sin horario
  // cargado no hay disponibilidad. Por eso el ALTA encadena con esa pantalla,
  // y la EDICIÓN no — a quien vino a corregir un nombre no se lo muda de lugar.
  if (!id) redirect(`/panel/profesionales/${staffId}/horarios`);

  return { status: "success", message: "Profesional actualizado." };
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

  /**
   * Reactivar también gasta cupo, y sin este chequeo el límite se saltea solo:
   * pausar a uno, crear otro con el lugar liberado, y reactivar al pausado deja
   * al negocio por encima del tope. Pausar, en cambio, nunca se bloquea — es la
   * salida del que quedó por encima, trabarla lo dejaría encerrado.
   *
   * El conteo excluye a este profesional: se pregunta si entra ÉL, así que
   * contarlo a sí mismo haría fallar una reactivación que no cambia nada.
   */
  if (active) {
    const others = await countActiveStaff(tenant.id, id);
    if (!others.ok) return errorState(others.error.message);

    if (!hasRoomForStaff(tenant.plan, others.value)) {
      return errorState(
        `Tu plan permite hasta ${limitsFor(tenant.plan).staff} profesionales activos. Pausá a otro antes de reactivar a este, o pasá a un plan más grande.`,
      );
    }
  }

  const supabase = await createClient();
  // Cero filas afectadas no es éxito: ver `core/db-write.ts`.
  const written = await supabase
    .from("staff")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenant.id)
    .select("id");

  if (!wroteRows(written)) {
    return errorState("No pudimos cambiar el estado del profesional.");
  }

  revalidateStaff(tenant);
  return {
    status: "success",
    message: active ? "Profesional activado." : "Profesional pausado.",
  };
}

/**
 * Baja definitiva de un profesional. La regla (¿tiene turnos que la
 * bloquean?) vive en la base: `delete_staff()` cuenta por status, desvincula
 * los turnos terminales y borra, todo en una transacción, y devuelve un
 * `delete_outcome`. Acá sólo se traduce ese resultado a copy — ya NO se hace
 * el conteo desde la aplicación (era redundante contra la RPC y, peor, racy:
 * un turno podía crearse entre el conteo y el DELETE). El `23503` sigue como
 * red de contención para una excepción real (p. ej. la RPC no existe
 * todavía), no como el camino normal — bloqueado es un resultado válido, no
 * un error. La FK de `bookings.staff_id` ahora es `on delete restrict`
 * (antes `cascade`), así que la base tampoco dejaría borrar un profesional
 * con turnos aunque esta action tuviera un bug.
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
  const { data, error } = await supabase.rpc("delete_staff", {
    p_tenant_id: tenant.id,
    p_staff_id: id,
  });

  if (error) {
    return errorState(
      error.code === FOREIGN_KEY_VIOLATION
        ? "Este profesional ya tiene turnos, así que no se puede eliminar sin perderlos. Pausalo para dejar de ofrecerlo."
        : "No pudimos eliminar al profesional. Intentá de nuevo.",
    );
  }

  if (data === "blocked_upcoming" || data === "blocked_history") {
    return errorState(deleteBlockMessage(data, "profesional"));
  }

  revalidateStaff(tenant);
  return { status: "success", message: "Profesional eliminado." };
}

/**
 * Guarda el horario semanal completo de un profesional.
 *
 * Se reemplaza la semana entera en vez de reconciliar franja por franja: las
 * filas de `staff_availability` no tienen identidad estable para el usuario —
 * nadie edita "la franja 3", edita "el horario".
 *
 * El reemplazo lo hace `replace_staff_schedule` (SECURITY DEFINER, estilo
 * `create_booking`) en UNA transacción: si algo falla, la semana anterior
 * queda intacta. Antes era DELETE + INSERT en dos llamadas y un fallo en la
 * segunda dejaba al profesional sin horario.
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
  const { error } = await supabase.rpc("replace_staff_schedule", {
    p_staff_id: staffId,
    p_windows: schedule.value.map((w) => ({
      weekday: w.weekday,
      start_time: w.startTime,
      end_time: w.endTime,
    })),
  });

  if (error) {
    return errorState("No pudimos guardar el horario. Intentá de nuevo.");
  }

  revalidateStaff(tenant);
  revalidatePath(`/panel/profesionales/${staffId}/horarios`);

  // El horario es el último paso de la puesta a punto: terminarlo devuelve al
  // listado, que es desde donde se sigue trabajando.
  redirect("/panel/profesionales");

  return { status: "success", message: "Horario guardado." };
}
