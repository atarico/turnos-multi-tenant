import type { Subscription } from "@/modules/billing/domain/subscription";
import type { CountryCode } from "@/modules/tenants/domain/countries";
import type { PlanTier } from "@/modules/tenants/domain/types";

/**
 * Un negocio visto desde el panel de plataforma.
 *
 * Es un tipo propio y no `Tenant` a propósito, por la misma razón que
 * `PublicTenant`: acá se listan TODOS los negocios, así que cada columna que
 * sobre viaja multiplicada por la plataforma entera. Sólo entra lo que se
 * pinta en la lista — `timezone`, `logo_url` y `brand_color` son cosas del
 * panel de cada dueño y no tienen nada que hacer en esta pantalla.
 *
 * snake_case porque son las filas de `tenants` tal como las devuelve PostgREST,
 * igual que {@link Tenant}: sin mapper de por medio, inventar camelCase sería
 * una capa de traducción que nadie pidió.
 */
export interface AdminTenant {
  id: string;
  slug: string;
  name: string;
  country: CountryCode;
  plan: PlanTier;
  created_at: string;
}

/**
 * Un negocio visto desde la plataforma, con su suscripción al lado.
 *
 * Las dos cosas van juntas y no separadas a propósito: la pregunta que el
 * operador trae a esta pantalla no es "qué plan tiene" ni "qué suscripción
 * tiene", es si las dos dicen lo mismo. Ver [[planIsOutOfSync]].
 *
 * `subscription` en `null` significa que el negocio no tiene NINGUNA, ni
 * siquiera cancelada. Que la consulta haya fallado nunca llega hasta acá: eso
 * sale por el `err` del `Result`.
 */
export interface AdminTenantDetail {
  tenant: AdminTenant;
  subscription: Subscription | null;
}
