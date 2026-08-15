"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

import { normalizeBrandColor } from "../domain/brand";
import { SUPPORTED_COUNTRIES } from "../domain/countries";
import { generateTenantSlug } from "../domain/slug";
import { getCurrentTenant } from "./queries";

const createBusinessSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(2, "El nombre del negocio es muy corto")
    .max(60, "Máximo 60 caracteres"),
  country: z.enum(SUPPORTED_COUNTRIES, { message: "Elegí un país" }),
});

/**
 * Crea un negocio para el usuario ya autenticado (flujo de onboarding, cuando
 * el registro no lo creó por confirmación de email). Delega en la función
 * Postgres create_business() que inserta tenant + membresía owner atómicamente.
 */
export async function createBusinessAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createBusinessSchema.safeParse({
    businessName: String(formData.get("businessName") ?? ""),
    country: String(formData.get("country") ?? ""),
  });

  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fields[key]) fields[key] = issue.message;
    }
    return errorState("Revisá los datos del formulario.", fields);
  }

  const supabase = await createClient();
  const slug = generateTenantSlug(parsed.data.businessName);

  const { error } = await supabase.rpc("create_business", {
    p_name: parsed.data.businessName,
    p_slug: slug,
    p_country: parsed.data.country,
  });

  if (error) {
    return errorState("No pudimos crear tu negocio. Intentá de nuevo.");
  }

  revalidatePath("/panel");
  // Repone el disparador del modal: el rebote a `/panel/bienvenida` se comió el
  // `?bienvenida=1` que traían el alta y el login, y sin reponerlo acá el modal
  // recién aparecería al segundo login.
  redirect("/panel?bienvenida=1");
}

/**
 * Guarda el color de marca del negocio.
 *
 * Valida ANTES de escribir, no al pintar: el color termina inyectado como valor
 * de una custom property CSS en la página pública, así que lo que no pasa la
 * lista blanca del dominio no llega nunca a la base. Ver `domain/brand.ts`.
 *
 * No hace falta filtrar por dueño a mano — la política `tenants_update_members`
 * ya limita el UPDATE a los negocios del usuario. El `.eq("id", ...)` está para
 * acotar la fila, no para autorizar.
 *
 * A diferencia del onboarding, acá NO se redirige: el dueño se queda en su
 * configuración viendo el resultado. Por eso devuelve un estado de éxito de
 * verdad, y no uno inalcanzable detrás de un `redirect()`.
 */
export async function updateBrandingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const brandColor = normalizeBrandColor(String(formData.get("brandColor") ?? ""));

  if (!brandColor) {
    return errorState("Revisá los datos del formulario.", {
      brandColor: "Elegí un color válido.",
    });
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return errorState("No encontramos tu negocio.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tenants")
    .update({ brand_color: brandColor })
    .eq("id", tenant.id);

  if (error) {
    return errorState("No pudimos guardar el color. Intentá de nuevo.");
  }

  revalidatePath("/panel/configuracion");
  // La página pública es el ÚNICO lugar donde el color se ve. Sin esta línea el
  // dueño guarda, ve el cambio en el panel, abre su link y sigue con el viejo.
  revalidatePath(`/${tenant.slug}`);

  return { status: "success", message: "Listo, guardamos tu color." };
}
