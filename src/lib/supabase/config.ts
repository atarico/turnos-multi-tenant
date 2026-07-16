/**
 * Indica si las credenciales de Supabase son reales (no placeholders).
 *
 * Permite desarrollar la UI antes de crear el proyecto Supabase: si todavía no
 * está configurado, el middleware saltea la lógica de auth en vez de intentar
 * (y colgarse) conectándose a un proyecto inexistente.
 */
export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) return false;
  return !url.includes("placeholder") && !url.includes("TODO");
}
