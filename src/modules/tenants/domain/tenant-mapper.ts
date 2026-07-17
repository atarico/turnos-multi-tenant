import type { PublicTenant } from "./types";

/** Fila cruda de la vista `public_tenants` (columnas ver migration 0004). */
export interface PublicTenantRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  brand_color: string;
  logo_url: string | null;
}

/** Fila de `public_tenants` → `PublicTenant`. Función pura, sin I/O. */
export function toPublicTenant(r: PublicTenantRow): PublicTenant {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    timezone: r.timezone,
    brandColor: r.brand_color,
    logoUrl: r.logo_url,
  };
}
