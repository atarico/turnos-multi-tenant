"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

/**
 * Otorgar y quitar un plan de cortesía, desde el panel de plataforma.
 *
 * ## Estas acciones NO autorizan nada
 *
 * La reja está adentro de `grant_plan_courtesy` / `revoke_plan_courtesy`, que
 * chequean `is_super_admin()` en la base. Acá no se repite el chequeo, y es
 * deliberado: un `if` de más en TypeScript daría la impresión de que la
 * seguridad vive en dos lados, y el día que alguien lo relaje "porque el otro
 * ya chequea" no se sabría cuál era el que valía. Vale el de la base, siempre.
 *
 * Se llaman con el cliente de SESIÓN, nunca con la service key: quién otorgó la
 * cortesía sale de `auth.uid()` adentro de la función, y con la service key no
 * habría a quién anotar.
 */

const grantSchema = z.object({
  tenantId: z.string().uuid("Negocio inválido."),
  slug: z.string().min(1),
  plan: z.enum(["basico", "pro", "premium"], {
    message: "Elegí un plan.",
  }),
  reason: z
    .string()
    .trim()
    .min(3, "Contá por qué se otorga: dentro de seis meses nadie se acuerda."),
  // Un `<input type="date">` vacío manda "". Se normaliza a null acá y no en la
  // base, porque "sin vencimiento" es una respuesta legítima del formulario.
  until: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .nullable(),
});

export async function grantCourtesyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = grantSchema.safeParse({
    tenantId: formData.get("tenantId"),
    slug: formData.get("slug"),
    plan: formData.get("plan"),
    reason: formData.get("reason"),
    until: formData.get("until"),
  });

  if (!parsed.success) {
    return errorState("Revisá los datos.", zodFieldErrors(parsed.error));
  }

  const { tenantId, slug, plan, reason, until } = parsed.data;
  const supabase = await createClient();

  const { error } = await supabase.rpc("grant_plan_courtesy", {
    p_tenant_id: tenantId,
    p_plan: plan,
    p_reason: reason,
    // Una fecha suelta es medianoche UTC de ese día. La cortesía vence al
    // EMPEZAR el día elegido; elegir hoy ya está vencido y la base lo rechaza.
    p_until: until ? `${until}T00:00:00Z` : null,
  });

  if (error) return errorState(courtesyError(error.message));

  revalidatePath(`/admin/${slug}`);
  return { status: "success", message: "Cortesía otorgada." };
}

export async function revokeCourtesyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const tenantId = z.string().uuid().safeParse(formData.get("tenantId"));
  const slug = z.string().min(1).safeParse(formData.get("slug"));

  if (!tenantId.success || !slug.success) {
    return errorState("Negocio inválido.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_plan_courtesy", {
    p_tenant_id: tenantId.data,
  });

  if (error) return errorState(courtesyError(error.message));

  revalidatePath(`/admin/${slug.data}`);
  return { status: "success", message: "Cortesía quitada." };
}

/**
 * El mensaje de Postgres NO se muestra tal cual.
 *
 * Trae el nombre de la función, el del negocio y a veces el SQL: nada de eso le
 * sirve a quien está mirando la pantalla, y todo eso le sirve a quien está
 * probando qué hay del otro lado. Se traduce lo que el operador puede accionar
 * y el resto cae en un mensaje único.
 */
function courtesyError(message: string): string {
  if (message.includes("solo un operador de plataforma")) {
    return "Tu cuenta no puede otorgar cortesías.";
  }
  if (message.includes("necesita un motivo")) {
    return "La cortesía necesita un motivo.";
  }
  if (message.includes("vencimiento")) {
    return "El vencimiento tiene que ser una fecha futura.";
  }
  if (message.includes("no existe el negocio")) {
    return "Ese negocio ya no existe.";
  }
  return "No pudimos guardar el cambio. Intentá de nuevo.";
}
