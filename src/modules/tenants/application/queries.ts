import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

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
  // El join devuelve el tenant relacionado; lo normalizamos al tipo Tenant.
  return (data.tenants as unknown as Tenant) ?? null;
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
    .select("id, slug, name, timezone, brand_color, logo_url")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) return null;
  return toPublicTenant(data as PublicTenantRow);
}
