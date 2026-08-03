import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import { normalizeTime, type ScheduleWindow } from "../domain/schedule";
import type { StaffMember } from "../domain/types";

interface StaffRow {
  id: string;
  name: string;
  role: string | null;
  active: boolean;
  // Embed a-muchos vía `staff_services.staff_id`: PostgREST lo devuelve array.
  staff_services: { service_id: string }[];
}

const toStaffMember = (r: StaffRow): StaffMember => ({
  id: r.id,
  name: r.name,
  role: r.role,
  active: r.active,
  serviceIds: r.staff_services.map((s) => s.service_id),
});

/**
 * Profesionales del negocio, activos e inactivos, con los servicios que presta
 * cada uno. El embed trae las asignaciones en la misma consulta para no hacer
 * un N+1 al pintar la lista.
 *
 * Se filtra por `tenant_id` explícito además de la RLS: defensa en profundidad.
 */
export async function listStaffMembers(
  tenantId: string,
): Promise<Result<StaffMember[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, name, role, active, staff_services(service_id)")
    .eq("tenant_id", tenantId)
    .order("active", { ascending: false })
    .order("name");

  if (error) {
    return err(
      appError("staff_query_failed", "No pudimos cargar tus profesionales."),
    );
  }
  return ok((data as unknown as StaffRow[]).map(toStaffMember));
}

/**
 * Un profesional puntual del negocio.
 *
 * El filtro por `tenant_id` es el guard de aislamiento: un `staffId` que venga
 * de la URL o de un form es input del cliente, y sin este chequeo se podría
 * pedir el profesional de otro negocio.
 */
export async function getStaffMember(
  tenantId: string,
  staffId: string,
): Promise<Result<StaffMember>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff")
    .select("id, name, role, active, staff_services(service_id)")
    .eq("tenant_id", tenantId)
    .eq("id", staffId)
    .maybeSingle();

  if (error) {
    return err(
      appError("staff_query_failed", "No pudimos cargar al profesional."),
    );
  }
  if (!data) {
    return err(appError("staff_not_found", "Ese profesional no existe."));
  }
  return ok(toStaffMember(data as unknown as StaffRow));
}

interface AvailabilityRow {
  weekday: number;
  start_time: string;
  end_time: string;
}

/**
 * Horario semanal de un profesional. Las horas vienen como "HH:MM:SS" de una
 * columna `time` y se normalizan acá para que la UI reciba lo que un
 * `<input type="time">` entiende.
 *
 * No filtra por tenant: el caller ya resolvió al profesional con
 * `getStaffMember`, que es quien hace el aislamiento.
 */
export async function getStaffSchedule(
  staffId: string,
): Promise<Result<ScheduleWindow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("staff_availability")
    .select("weekday, start_time, end_time")
    .eq("staff_id", staffId)
    .order("weekday")
    .order("start_time");

  if (error) {
    return err(
      appError("availability_query_failed", "No pudimos cargar el horario."),
    );
  }

  return ok(
    (data as AvailabilityRow[]).map((r) => ({
      weekday: r.weekday,
      startTime: normalizeTime(r.start_time) ?? r.start_time,
      endTime: normalizeTime(r.end_time) ?? r.end_time,
    })),
  );
}
