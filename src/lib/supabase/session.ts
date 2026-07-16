import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured } from "./config";

/**
 * Refresca la sesión de Supabase en cada request y la propaga vía cookies.
 *
 * Se invoca desde el Proxy de Next (src/proxy.ts). Es el patrón oficial de
 * @supabase/ssr: sin esto, los tokens expiran y los Server Components quedan
 * con sesiones viejas.
 *
 * La protección de rutas (redirigir si no hay usuario) se agrega más adelante,
 * cuando exista el dashboard. Por ahora solo mantiene la sesión fresca.
 */
export async function updateSession(request: NextRequest) {
  // Sin credenciales reales todavía: no intentamos hablar con Supabase.
  if (!isSupabaseConfigured()) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANTE: no metas lógica entre crear el client y getUser(). Si lo hacés,
  // podés provocar logouts intermitentes difíciles de debuggear.
  await supabase.auth.getUser();

  return supabaseResponse;
}
