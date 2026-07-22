import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

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
