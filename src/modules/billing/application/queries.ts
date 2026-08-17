import { createClient } from "@/lib/supabase/server";

import type { Subscription } from "../domain/subscription";
import { type SubscriptionRow, toSubscription } from "../domain/subscription-mapper";

/**
 * Estados en los que una suscripción está VIVA.
 *
 * `past_due` entra: el cobro falló pero el servicio sigue andando durante la
 * gracia. Dejarlo afuera cortaría el acceso por una tarjeta vencida, que es
 * exactamente lo que no queremos hacerle a un negocio que está atendiendo
 * gente. Espeja el índice único parcial `subscriptions_one_live_per_tenant`.
 */
const LIVE_STATUSES = ["trialing", "active", "past_due"] as const;

const COLUMNS =
  "id, tenant_id, plan, status, current_period_start, current_period_end, " +
  "trial_ends_at, price_usd_cents, charged_amount_cents, charged_currency, " +
  "fx_rate, fx_source, fx_quoted_at";

/**
 * La suscripción viva del negocio, o `null` si no tiene.
 *
 * Como mucho hay una: lo garantiza el índice único parcial en la base, no una
 * convención de este código. Por eso `maybeSingle()` puede confiar en que no
 * va a encontrar dos.
 *
 * Devuelve `null` ante CUALQUIER fallo, incluida una excepción. Es una
 * decisión de encuadre: esto alimenta un cartel informativo en el panel, y el
 * panel la mete en un `Promise.all` — una promesa rechazada ahí se lleva
 * puesta la pantalla entera por un cartel decorativo. Por eso el `try` abarca
 * también la creación del cliente y no sólo la consulta: mirar únicamente el
 * `error` de PostgREST dejaba afuera justo el camino que rompe.
 *
 * El día que algo COBRE en base a esto, ese algo necesita un camino de error
 * propio y no puede reusar esta función: acá un fallo es indistinguible de
 * "no tiene suscripción", y para cobrar esa diferencia es todo.
 */
export async function getCurrentSubscription(
  tenantId: string,
): Promise<Subscription | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("subscriptions")
      .select(COLUMNS)
      .eq("tenant_id", tenantId)
      .in("status", LIVE_STATUSES)
      .maybeSingle();

    if (error || !data) return null;
    return toSubscription(data as unknown as SubscriptionRow);
  } catch {
    return null;
  }
}
