import type { CountryCode } from "./countries";

export type PlanTier = "basico" | "pro" | "premium";

/**
 * Un negocio (tenant). Espeja la tabla public.tenants, con UNA excepción
 * declarada: `plan`.
 *
 * En la tabla, `plan` es lo que la pasarela cobra. Acá es lo que el negocio
 * PUEDE USAR, que no es lo mismo desde que existen las cortesías: un operador
 * puede regalar un plan mejor, con o sin vencimiento. `getCurrentTenant()`
 * resuelve la diferencia al leer, así que todo lo que decide límites
 * —`hasRoomForStaff`, `limitsFor`— ya recibe el plan correcto sin acordarse de
 * nada.
 *
 * Se eligió así, y no agregando un campo aparte que cada llamador tuviera que
 * recordar usar, porque olvidarse en un solo lugar le niega a un negocio algo
 * que se le regaló y el error se descubre cuando el cliente reclama. Lo pagado
 * sigue disponible en `paid_plan` para quien necesite la otra verdad.
 */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  country: CountryCode;
  timezone: string;
  /** El plan EFECTIVO: la cortesía viva si la hay, si no el pagado. */
  plan: PlanTier;
  /** Lo que la pasarela cobra. La columna cruda; sólo la mueve el webhook. */
  paid_plan: PlanTier;
  /** Plan regalado por un operador, o `null`. */
  plan_courtesy: PlanTier | null;
  /** Hasta cuándo dura el regalo. `null` con cortesía = hasta que la saquen. */
  plan_courtesy_until: string | null;
  /** Por qué se otorgó. La mitad del valor del registro. */
  plan_courtesy_reason: string | null;
  logo_url: string | null;
  brand_color: string;
  created_at: string;
  updated_at: string;
}

/**
 * Un negocio visto por un visitante anónimo en `/{slug}`. Espeja la vista
 * `public_tenants`, que NO expone `country`, `plan` ni timestamps. Tipo
 * distinto de {@link Tenant} a propósito: castear una fila pública a `Tenant`
 * mentiría al sistema de tipos y dejaría colar un campo del panel al camino
 * anónimo. camelCase para calzar con el resto del dominio de booking; el
 * mapeo desde la fila snake_case vive en `tenant-mapper.ts`.
 */
export interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  brandColor: string;
  logoUrl: string | null;
}
