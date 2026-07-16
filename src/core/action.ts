/**
 * Estado de una Server Action consumido por useActionState en los formularios.
 *
 * Modela explícitamente los tres momentos de un submit: inicial, error
 * (con errores por campo opcionales) y éxito. La UI reacciona al `status`.
 */
export type ActionState =
  | { status: "idle" }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string>;
    }
  | { status: "success"; message?: string };

export const idleState: ActionState = { status: "idle" };

/** Construye un estado de error con mensaje general y errores por campo. */
export function errorState(
  message: string,
  fieldErrors?: Record<string, string>,
): ActionState {
  return { status: "error", message, fieldErrors };
}
