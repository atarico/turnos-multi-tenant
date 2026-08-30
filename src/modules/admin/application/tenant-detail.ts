import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";
import {
  type SubscriptionRow,
  toSubscription,
} from "@/modules/billing/domain/subscription-mapper";

import type { AdminTenant, AdminTenantDetail } from "../domain/types";

const TENANT_COLUMNS = "id, slug, name, country, plan, created_at";

const SUBSCRIPTION_COLUMNS =
  "id, tenant_id, plan, status, current_period_start, current_period_end, " +
  "trial_ends_at, price_usd_cents, charged_amount_cents, charged_currency, " +
  "fx_rate, fx_source, fx_quoted_at";

const failed = () =>
  err(
    appError(
      "admin_tenant_detail_query_failed",
      "No pudimos cargar el detalle de este negocio.",
    ),
  );

/**
 * Un negocio y su suscripción, para el panel de plataforma.
 *
 * Tres desenlaces, y que se puedan distinguir es todo el punto:
 *
 *   `ok(detalle)`  el negocio existe
 *   `ok(null)`     no hay negocio con ese slug  → la pantalla hace 404
 *   `err(...)`     no se pudo preguntar         → la pantalla pinta el fallo
 *
 * Colapsar los dos últimos le mostraría un 404 al operador cada vez que la base
 * tose, y buscar durante media hora un negocio que sí está.
 *
 * ## Por qué no reusa `getCurrentSubscription`
 *
 * Por dos motivos, y los dos importan acá:
 *
 * 1. **Aquélla filtra por estados vivos.** Esconde las canceladas, que es
 *    correcto para el panel del negocio —no hay nada que cobrar— y es
 *    exactamente lo que el operador necesita ver: alguien que se dio de baja no
 *    puede aparecer igual que alguien que nunca contrató.
 *
 * 2. **Aquélla se traga cualquier fallo como `null`.** Alimenta un cartel
 *    decorativo, así que un `null` de más cuesta un cartel de menos. Acá `null`
 *    significa "este negocio NO está pagando", y es el dato con el que el
 *    operador decide si alguien le debe plata. Un fallo de consulta disfrazado
 *    de `null` le hace creer que un cliente que paga no paga. La propia
 *    docstring de aquella función avisa que el día que algo dependa de la
 *    diferencia, necesita camino de error propio. Esto es ese día.
 *
 * Se toma la suscripción MÁS RECIENTE, no la viva: el índice único parcial
 * garantiza una sola viva, pero un negocio que se dio de baja tiene sólo
 * canceladas y su historia es la respuesta honesta a "qué pasa con éste".
 */
export async function getTenantDetail(
  slug: string,
): Promise<Result<AdminTenantDetail | null>> {
  try {
    const supabase = await createClient();

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select(TENANT_COLUMNS)
      .eq("slug", slug)
      .maybeSingle();

    if (tenantError) return failed();
    if (!tenant) return ok(null);

    const found = tenant as unknown as AdminTenant;

    const { data: subscription, error: subscriptionError } = await supabase
      .from("subscriptions")
      .select(SUBSCRIPTION_COLUMNS)
      .eq("tenant_id", found.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subscriptionError) return failed();

    return ok({
      tenant: found,
      subscription: subscription
        ? toSubscription(subscription as unknown as SubscriptionRow)
        : null,
    });
  } catch {
    return failed();
  }
}
