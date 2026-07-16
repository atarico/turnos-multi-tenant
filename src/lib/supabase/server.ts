import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cliente de Supabase para el SERVIDOR (Server Components, Server Actions,
 * Route Handlers). Lee y escribe la sesión en las cookies de la request.
 *
 * En Next 16 `cookies()` es async, por eso esta función es async.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `setAll` se llamó desde un Server Component, donde no se pueden
            // escribir cookies. No pasa nada: el middleware refresca la sesión.
          }
        },
      },
    },
  );
}
