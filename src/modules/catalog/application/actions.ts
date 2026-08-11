"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { createClient } from "@/lib/supabase/server";
import { deleteBlockMessage } from "@/modules/booking/domain/delete-outcome";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import type { Tenant } from "@/modules/tenants/domain/types";

import { serviceFormSchema } from "../domain/schemas";

/**
 * Server Actions del catálogo de servicios.
 *
 * Estas actions son alcanzables por POST directo, no sólo desde la UI: por eso
 * TODAS resuelven el negocio en el servidor con `getCurrentTenant()` y filtran
 * por `tenant_id`. Nunca se confía en un tenant que venga del cliente, y el
 * filtro explícito acompaña a la RLS en vez de reemplazarla.
 */

/** Código de violación de foreign key en Postgres. */
const FOREIGN_KEY_VIOLATION = "23503";

/** Refresca panel, catálogo y la página pública del negocio. */
function revalidateCatalog(tenant: Tenant) {
  revalidatePath("/panel");
  revalidatePath("/panel/servicios");
  revalidatePath(`/${tenant.slug}`);
}

/**
 * Alta o edición de un servicio, según venga o no `id` en el formulario. Un
 * solo camino para los dos casos: la validación y el mapeo son idénticos, lo
 * único que cambia es el verbo contra la base.
 */
export async function saveServiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = serviceFormSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    durationMin: String(formData.get("durationMin") ?? ""),
    price: String(formData.get("price") ?? ""),
    capacity: String(formData.get("capacity") ?? ""),
  });

  if (!parsed.success) {
    return errorState(
      "Revisá los datos del servicio.",
      zodFieldErrors(parsed.error),
    );
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const id = String(formData.get("id") ?? "").trim();
  const values = {
    name: parsed.data.name,
    description: parsed.data.description,
    duration_min: parsed.data.durationMin,
    price_cents: parsed.data.priceCents,
    capacity: parsed.data.capacity,
  };

  const supabase = await createClient();
  const { error } = id
    ? await supabase
        .from("services")
        .update(values)
        .eq("id", id)
        .eq("tenant_id", tenant.id)
    : await supabase.from("services").insert({ ...values, tenant_id: tenant.id });

  if (error) {
    return errorState(
      id
        ? "No pudimos guardar los cambios. Intentá de nuevo."
        : "No pudimos crear el servicio. Intentá de nuevo.",
    );
  }

  revalidateCatalog(tenant);
  return {
    status: "success",
    message: id ? "Servicio actualizado." : "Servicio creado.",
  };
}

/**
 * Activa o pausa un servicio. Pausar lo saca de la página pública sin tocar
 * los turnos ya reservados, que es lo que se quiere el 90% de las veces.
 */
export async function toggleServiceActiveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return errorState("No pudimos identificar el servicio.");

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const active = String(formData.get("active") ?? "") === "true";

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ active })
    .eq("id", id)
    .eq("tenant_id", tenant.id);

  if (error) {
    return errorState("No pudimos cambiar el estado del servicio.");
  }

  revalidateCatalog(tenant);
  return {
    status: "success",
    message: active ? "Servicio activado." : "Servicio pausado.",
  };
}

/**
 * Baja definitiva. La regla (¿tiene turnos que la bloquean?) vive en la base:
 * `delete_service()` cuenta por status, desvincula los turnos terminales y
 * borra, todo en una transacción, y devuelve un `delete_outcome`. Acá sólo se
 * traduce ese resultado a copy. El `23503` sigue como red de contención para
 * una excepción real (p. ej. la RPC no existe todavía), no como el camino
 * normal — bloqueado es un resultado válido, no un error.
 */
export async function deleteServiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return errorState("No pudimos identificar el servicio.");

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_service", {
    p_tenant_id: tenant.id,
    p_service_id: id,
  });

  if (error) {
    return errorState(
      error.code === FOREIGN_KEY_VIOLATION
        ? "Este servicio ya tiene turnos, así que no se puede eliminar. Pausalo para dejar de ofrecerlo."
        : "No pudimos eliminar el servicio. Intentá de nuevo.",
    );
  }

  if (data === "blocked_upcoming" || data === "blocked_history") {
    return errorState(deleteBlockMessage(data, "servicio"));
  }

  revalidateCatalog(tenant);
  return { status: "success", message: "Servicio eliminado." };
}
