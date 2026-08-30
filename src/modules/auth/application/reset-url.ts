import { passwordResetRedirectUrl } from "../domain/reset-url";

/** Origen de desarrollo: sirve para que el link ande, no para producción. */
const FALLBACK_ORIGIN = "http://localhost:3000";

/**
 * Resuelve el `redirectTo` del mail de recuperación leyendo el origen del
 * entorno.
 *
 * Vive acá y no en `domain` porque toca `process.env`: el dominio se mantiene
 * puro (recibe el origen inyectado) y este es el único lugar que lo lee.
 *
 * El aviso importa más acá que en los links del panel: un link de recuperación
 * apuntando a localhost sale igual por mail y llega a alguien que no puede
 * abrirlo, y como es de un solo uso, se quema el intento sin que nadie se
 * entere de por qué.
 */
export function resolvePasswordResetRedirectUrl(): string {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL;
  if (!configuredOrigin) {
    console.warn(
      `NEXT_PUBLIC_APP_URL is not set; password reset links fall back to ${FALLBACK_ORIGIN}`,
    );
  }
  return passwordResetRedirectUrl(configuredOrigin || FALLBACK_ORIGIN);
}
