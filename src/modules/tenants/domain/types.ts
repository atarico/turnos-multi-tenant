import type { CountryCode } from "./countries";

export type PlanTier = "basico" | "pro" | "premium";

/** Un negocio (tenant). Espeja la tabla public.tenants. */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  country: CountryCode;
  timezone: string;
  plan: PlanTier;
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
