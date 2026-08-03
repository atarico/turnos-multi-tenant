import type { ActionState } from "@/core/action";

/**
 * Costura entre la UI del catálogo y sus Server Actions (misma inversión de
 * dependencia que `BookingActions` en el módulo booking): los componentes
 * reciben las operaciones por prop en vez de importarlas, así se renderizan en
 * un test sin arrastrar Supabase ni `next/cache`.
 */
export interface ServiceActions {
  /** Alta y edición: distingue por el campo `id` del FormData. */
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  /** Activa o pausa un servicio sin borrarlo. */
  toggleActive: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  /** Baja definitiva. Falla si el servicio ya tiene turnos. */
  remove: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}
