import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env";

/**
 * Cliente de Supabase con `service_role`. Saltea RLS por completo.
 *
 * Existe porque hay caminos del servidor que no tienen sesión de un miembro y
 * aun así tienen que leer o escribir con autoridad:
 *   · la reserva pública: el visitante anónimo no puede ejecutar
 *     `create_booking()` (se le revocó el grant, porque la anon key viaja al
 *     browser y con ella cualquiera pegaba contra PostgREST sin pasar por la
 *     app). Entra por `create_public_booking()`, que sólo `service_role` puede
 *     llamar: nuestro servidor es la única puerta, y eso hace que el freno por
 *     IP sirva de algo;
 *   · los pagos: guardar y leer los tokens de Mercado Pago del negocio, crear
 *     las preferencias, el webhook, la página pública de retorno de la reserva
 *     y el cron que vence holds y renueva tokens. Ninguno tiene un miembro
 *     logueado detrás.
 *
 * REGLA: sólo del lado del servidor y con un alcance explícito: cada uso filtra
 * por el negocio (o la reserva) que le toca, y recibe el id desde un valor ya
 * validado, nunca de input crudo. NUNCA para lecturas que le pertenecen a una
 * sesión: eso va por `@/lib/supabase/server`, que respeta la sesión y la RLS.
 * Un `select` de más hecho desde acá lee la base entera de todos los negocios.
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
