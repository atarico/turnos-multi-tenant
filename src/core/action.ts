import type { z } from "zod";

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

/**
 * Mapea los issues de zod a un { campo: mensaje } para pintar bajo cada input,
 * que es lo que `errorState` espera como `fieldErrors`.
 *
 * Vive acá, y no en cada módulo, porque toda Server Action con formulario hace
 * exactamente esta traducción. No puede exportarse desde un `actions.ts`: en un
 * archivo "use server" todo export tiene que ser una action async.
 */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !fields[key]) fields[key] = issue.message;
  }
  return fields;
}
