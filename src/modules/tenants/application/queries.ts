import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { effectivePlan, type TrialInfo } from "@/modules/billing/domain/courtesy";
import { isInTrial } from "@/modules/billing/domain/subscription";

import { toPublicTenant, type PublicTenantRow } from "../domain/tenant-mapper";
import type { PublicTenant, Tenant } from "../domain/types";

/**
 * Devuelve el negocio del usuario autenticado (o null si no tiene ninguno).
 *
 * No necesita filtrar por tenant_id a mano: la RLS de `memberships` ya limita
 * las filas a las del usuario. La seguridad la garantiza la base de datos.
 */
export async function getCurrentTenant(): Promise<Tenant | null> {
  // Defensa en la capa de datos: en App Router la page se ejecuta aunque el
  // layout muestre otra cosa, así que cortamos ANTES de tocar Supabase si las
  // credenciales todavía son placeholders.
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("memberships")
    .select("tenants(*)")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  if (!data.tenants) return null;

  const tenantRow = data.tenants as unknown as TenantRow;
  const now = new Date();
  return withEffectivePlan(tenantRow, now, await readTrial(supabase, tenantRow.id, now));
}

/**
 * La prueba viva del negocio, o `null`.
 *
 * Una lectura aparte y no un embed en la consulta de arriba: así un fallo acá
 * no puede llevarse puesta la carga del negocio, que es lo que todo el panel
 * necesita. Ante cualquier error, "sin prueba": el negocio queda con lo que
 * paga, que es el lado seguro de equivocarse.
 */
async function readTrial(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  now: Date,
): Promise<TrialInfo | null> {
  try {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("status, trial_ends_at")
      .eq("tenant_id", tenantId)
      .eq("status", "trialing");
    if (error || !data) return null;

    for (const sub of data) {
      const trial: TrialInfo = {
        status: "trialing",
        trialEndsAt: sub.trial_ends_at ? new Date(sub.trial_ends_at) : null,
      };
      if (isInTrial(trial, now)) return trial;
    }
    return null;
  } catch {
    return null;
  }
}

/** La fila cruda de `tenants`: acá `plan` todavía es lo que se cobra. */
type TenantRow = Omit<Tenant, "paid_plan" | "trial_active">;

/**
 * Resuelve el plan efectivo ANTES de que la fila salga de la capa de datos.
 *
 * Es el único lugar donde una cortesía se convierte en permiso. Hacerlo acá y
 * no en cada pantalla es deliberado: los límites se chequean en
 * `staff/actions.ts` y se muestran en dos páginas más, y un llamador que se
 * olvide de resolverlo no rompe nada visible — simplemente le niega a un
 * negocio algo que se le regaló, y eso se descubre cuando el cliente reclama.
 *
 * Exportada para poder probarla sin levantar Supabase.
 */
export function withEffectivePlan(
  row: TenantRow,
  now: Date,
  trial: TrialInfo | null = null,
): Tenant {
  const plan = effectivePlan(
    {
      plan: row.plan,
      planCourtesy: row.plan_courtesy ?? null,
      planCourtesyUntil: row.plan_courtesy_until
        ? new Date(row.plan_courtesy_until)
        : null,
      trial,
    },
    now,
  );

  return {
    ...row,
    plan,
    paid_plan: row.plan,
    trial_active: trial !== null && isInTrial(trial, now),
  };
}

/**
 * Resuelve el negocio para la página pública `/{slug}` leyendo la vista
 * anónima `public_tenants` (sin `country`/`plan`/timestamps). `null` cubre
 * "Supabase sin configurar", error de consulta y "no existe ese slug" por
 * igual: el caller (la route) llama `notFound()` en cualquiera de los tres
 * casos, así que no hace falta distinguirlos acá.
 */
export async function getTenantBySlug(slug: string): Promise<PublicTenant | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_tenants")
    .select("id, slug, name, timezone, brand_color, logo_url, takes_bookings")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) return null;
  return toPublicTenant(data as PublicTenantRow);
}
