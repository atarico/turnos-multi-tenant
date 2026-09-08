import type { PublicTenant } from "./types";

/** Fila cruda de la vista `public_tenants` (columnas ver migration 0004). */
export interface PublicTenantRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  brand_color: string;
  logo_url: string | null;
  takes_bookings: boolean | null;
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
    // `=== true` y no un `??`: ante un valor ausente o nulo se cierra, no se
    // abre. Lo que NO cubre —y conviene no creerse que sí— es una migración
    // sin aplicar: PostgREST rechaza el select por columna inexistente, eso
    // vuelve como error, y la route termina en `notFound()`. O sea 404, no
    // este default. La migración va ANTES que el deploy, como el resto.
    takesBookings: r.takes_bookings === true,
  };
}
