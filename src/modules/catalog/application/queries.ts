import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import type { CatalogService } from "../domain/types";

const SERVICE_COLUMNS =
  "id, name, description, duration_min, price_cents, currency, capacity, active";

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_cents: number;
  currency: string;
  capacity: number;
  active: boolean;
}

const toCatalogService = (r: ServiceRow): CatalogService => ({
  id: r.id,
  name: r.name,
  description: r.description,
  durationMin: r.duration_min,
  priceCents: r.price_cents,
  currency: r.currency,
  capacity: r.capacity,
  active: r.active,
});

/**
 * Todos los servicios del negocio, activos e inactivos, para gestionarlos en
 * el panel. Se filtra por `tenant_id` explícito además de la RLS: defensa en
 * profundidad, igual que en el resto de la capa de aplicación.
 *
 * Los activos van primero y dentro de cada grupo por nombre, que es como se
 * los busca cuando la lista crece.
 */
export async function listCatalogServices(
  tenantId: string,
): Promise<Result<CatalogService[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(SERVICE_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("active", { ascending: false })
    .order("name");

  if (error) {
    return err(
      appError("services_query_failed", "No pudimos cargar tus servicios."),
    );
  }
  return ok((data as ServiceRow[]).map(toCatalogService));
}
