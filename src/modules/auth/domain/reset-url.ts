/**
 * El destino del link de recuperación. Puro — no lee `process.env` — para que
 * el armado se pueda testear sin entorno y para que el único lugar que mira la
 * variable sea `application/reset-url.ts` (mismo corte que `public-url.ts`).
 */

/** A dónde va la persona una vez canjeado el token. */
export const NEW_PASSWORD_PATH = "/nueva-contrasena";

/** El route handler que canjea el `token_hash` y abre la sesión. */
const CONFIRM_PATH = "/auth/confirmar";

/**
 * Arma el `redirectTo` que se le pasa a `resetPasswordForEmail`.
 *
 * No apunta directo al formulario de contraseña nueva: apunta al route handler,
 * porque el link del mail trae un `token_hash` que hay que canjear por sesión
 * ANTES de que se pueda cambiar nada. El destino final viaja en `next`, y va
 * codificado porque es un path con barra: sin `encodeURIComponent` el `/`
 * quedaría crudo en la query y cualquier parámetro que se sume después
 * ambiguo.
 */
export function passwordResetRedirectUrl(origin: string): string {
  const trimmedOrigin = origin.replace(/\/+$/, "");
  const next = encodeURIComponent(NEW_PASSWORD_PATH);
  return `${trimmedOrigin}${CONFIRM_PATH}?next=${next}`;
}
