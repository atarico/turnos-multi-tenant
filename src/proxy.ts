import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/session";

/**
 * Proxy de Next 16 (antes "middleware"). Corre en el borde, delante de las
 * rutas, y mantiene fresca la sesión de Supabase en cada request. Next 16
 * renombró este convention para diferenciarlo del middleware de Express.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Corre en todas las rutas EXCEPTO assets estáticos e imágenes,
     * para no penalizar archivos que no necesitan sesión.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
