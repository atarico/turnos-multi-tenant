"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

import { SUPPORTED_COUNTRIES } from "../domain/countries";
import { generateTenantSlug } from "../domain/slug";

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
  redirect("/panel");
}
