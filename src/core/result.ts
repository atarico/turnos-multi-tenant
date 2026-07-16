/**
 * Result<T, E>: resultado explícito de una operación que puede fallar.
 *
 * En vez de tirar excepciones por todos lados, las operaciones de la capa de
 * aplicación devuelven un Result. El error pasa a ser parte del tipo de retorno,
 * así el compilador te obliga a manejarlo. Menos `try/catch` disperso, más control.
 */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Error de dominio con código estable para discriminar en la UI. */
export interface AppError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

export const appError = (
  code: string,
  message: string,
  cause?: unknown,
): AppError => ({ code, message, cause });
