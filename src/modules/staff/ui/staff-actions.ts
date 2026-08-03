import type { ActionState } from "@/core/action";

/**
 * Costura entre la UI de profesionales y sus Server Actions, igual que
 * `ServiceActions` en el catálogo: los componentes reciben las operaciones por
 * prop en vez de importarlas, así se renderizan en un test sin arrastrar
 * Supabase ni `next/cache`.
 */
export interface StaffActions {
  /** Alta y edición: distingue por el campo `id` del FormData. */
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  /** Activa o pausa un profesional sin borrarlo. */
  toggleActive: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  /** Baja definitiva. Se rechaza si el profesional ya tiene turnos. */
  remove: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}
