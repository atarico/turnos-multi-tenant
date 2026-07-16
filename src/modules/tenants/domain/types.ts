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
