import { publicBookingUrl } from "../domain/public-url";

/** Origen de desarrollo: sirve para que el link ande, no para producción. */
const FALLBACK_ORIGIN = "http://localhost:3000";

/**
 * Resuelve la URL pública de reservas del negocio leyendo el origen del
 * entorno.
 *
 * Vive acá y no en `domain` porque toca `process.env`: el dominio se mantiene
 * puro (recibe el origen inyectado) y este es el único lugar que lo lee, así
 * las pantallas que muestran el link no repiten el bloque de fallback + aviso.
 *
 * Literal member access (not `serverEnv()`): panel pages don't otherwise
 * depend on the service-role env surface, and this keeps them free of it.
 */
export function resolvePublicBookingUrl(slug: string): string {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL;
  if (!configuredOrigin) {
    console.warn(
      `NEXT_PUBLIC_APP_URL is not set; public booking links fall back to ${FALLBACK_ORIGIN}`,
    );
  }
  return publicBookingUrl(configuredOrigin || FALLBACK_ORIGIN, slug);
}
