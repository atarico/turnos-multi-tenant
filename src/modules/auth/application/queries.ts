import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

/**
 * Nombre con el que la persona se registró (`user_metadata.full_name`).
 *
 * Es un dato de cortesía: devuelve null si no hay sesión o si el metadato
 * llegó vacío, así que ninguna pantalla puede depender de que exista.
 */
export async function getCurrentUserName(): Promise<string | null> {
  // Misma defensa que `getCurrentTenant`: cortamos antes de tocar Supabase si
  // las credenciales todavía son placeholders.
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const fullName = user.user_metadata?.full_name;
  if (typeof fullName !== "string") return null;

  return fullName.trim() || null;
}
