import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env";

/**
 * Cliente de Supabase con `service_role`. Saltea RLS por completo.
 *
 * Existe por UNA razón: el visitante anónimo ya no puede ejecutar
 * `create_booking()` (se le revocó el grant), porque la anon key viaja al
 * browser y con ella cualquiera pegaba contra PostgREST directo, sin pasar por
 * la app, y le llenaba la agenda a cualquier negocio. Ahora la reserva pública
 * entra por `create_public_booking()`, que sólo `service_role` puede llamar.
 * Eso convierte a nuestro servidor en la única puerta, que es la condición
 * para que el freno por IP sirva de algo.
 *
 * REGLA: usar este cliente SÓLO para esa llamada. Todo lo demás va por
 * `@/lib/supabase/server`, que respeta la sesión y la RLS. Un `select` de más
 * hecho desde acá lee la base entera de todos los negocios.
 *
 * El `import "server-only"` no es decorativo: si alguien lo importa desde un
 * Client Component, el build falla en vez de filtrar la clave al bundle.
 */
export function createAdminClient() {
  const env = serverEnv();

  return createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    // Sin sesión y sin persistirla: este cliente no representa a un usuario.
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
