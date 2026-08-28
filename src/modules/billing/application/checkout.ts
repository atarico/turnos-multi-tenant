import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlanTier } from "@/modules/tenants/domain/types";

import { planLabel } from "../domain/plan";
import { priceUsdCentsFor, usdCentsToArsCents } from "../domain/price";
import { quoteUsdToArs } from "./fx";
import { createPreapproval } from "./mercadopago";
import { getLiveSubscriptionIdForCharge } from "./queries";

/** Quién cobra. Hoy hay una sola; el país decide cuál. Ver `countries.ts`. */
const PROVIDER = "mercadopago";

/**
 * Lo máximo que entra en `subscriptions.charged_amount_cents`, que es un `int`.
 *
 * No es un límite de negocio: es el techo de la columna, y está acá porque el
 * código puede producir un número que no entra. `fx.ts` acepta cotizaciones de
 * hasta 10.000.000 de pesos por dólar —a propósito, es un filtro de basura y no
 * una predicción del mercado—, y Premium a esa tasa da 70.000.000.000 de
 * centavos.
 *
 * Chequearlo acá y no dejar que lo ataje la base es lo que evita el peor
 * desenlace: el `UPDATE` falla DESPUÉS de que la pasarela ya abrió la
 * suscripción, o sea que produce justo el huérfano que el orden de esta función
 * existe para evitar.
 */
const MAX_CHARGED_AMOUNT_CENTS = 2_147_483_647;

/**
 * La suscripción quedó abierta en la pasarela y nuestra fila no la conoce.
 *
 * Vive en una constante y no repetido en cada camino porque los dos modos de
 * fallar —la base devuelve error y la base TIRA— dejan al dueño exactamente en
 * la misma situación, y tienen que decirle exactamente lo mismo. El mensaje
 * pide escribir antes de reintentar porque un reintento a ciegas abre una
 * segunda suscripción que también cobra.
 */
const notStamped = () =>
  err(
    appError(
      "checkout_not_stamped",
      "Abrimos la suscripción con Mercado Pago pero no pudimos terminar de " +
        "registrarla. Escribinos antes de volver a intentar, así no te " +
        "quedan dos.",
    ),
  );

export interface CheckoutSession {
  /** A dónde mandar al pagador para que ponga la tarjeta. */
  initPoint: string;
}

export interface StartCheckoutParams {
  tenantId: string;
  plan: PlanTier;
  payerEmail: string;
  /** A dónde vuelve el pagador cuando termina en la pasarela. */
  backUrl: string;
  now?: Date;
}

/**
 * Abre el cobro de un plan: cotiza, abre la suscripción en la pasarela, y deja
 * estampado en nuestra fila el precio, el monto y la cotización que lo produjo.
 *
 * EL ORDEN ES PARTE DEL DISEÑO, no una casualidad de cómo quedó escrito:
 *
 *   1. Leer la suscripción viva. Sin ella no hay a qué atar el cobro, y su
 *      lectura devuelve `Result` justamente para poder distinguir "no tiene"
 *      de "la base no contestó".
 *   2. Cotizar. Si no hay cotización NO se cobra: no hay último valor conocido
 *      ni precio de respaldo, porque cobrar un número inventado es peor que no
 *      cobrar. Esto se corta antes de tocar la pasarela.
 *   3. Abrir en la pasarela.
 *   4. Recién ahí estampar.
 *
 * Estampar antes del paso 3 dejaría una fila diciendo que se cobra por un id
 * que puede no existir nunca. Hacerlo en el orden de acá deja una sola ventana
 * fea —la pasarela abrió y la base no guardó— que tiene código de error propio
 * (`checkout_not_stamped`) porque lo que queda del otro lado es real y hay que
 * reconciliarlo por `external_reference`.
 *
 * NO mueve el estado de la suscripción ni el plan efectivo del negocio. Eso lo
 * hace el webhook cuando un cobro entra de verdad; acá lo único que pasó es que
 * alguien apretó un botón.
 */
export async function startCheckout(
  params: StartCheckoutParams,
): Promise<Result<CheckoutSession>> {
  const { tenantId, plan, payerEmail, backUrl, now = new Date() } = params;

  const subscriptionId = await getLiveSubscriptionIdForCharge(tenantId);
  if (!subscriptionId.ok) return subscriptionId;

  const quote = await quoteUsdToArs(now);
  if (!quote.ok) return quote;

  const priceUsdCents = priceUsdCentsFor(plan);

  // `usdCentsToArsCents` rompe ante una entrada imposible en vez de devolver un
  // número raro, y hace bien. Pero acá arriba una excepción sería un 500 en la
  // cara del dueño: las dos entradas ya vienen validadas —el precio de la tabla
  // y la tasa de la banda de plausibilidad de `fx.ts`—, así que este camino no
  // debería ocurrir nunca. Se lo convierte igual, porque "no debería ocurrir"
  // sobre plata no es una garantía.
  let amountArsCents: number;
  try {
    amountArsCents = usdCentsToArsCents(priceUsdCents, quote.value.rate);
  } catch {
    return err(
      appError(
        "price_conversion_failed",
        "No pudimos calcular el precio en pesos. Intentá de nuevo en un momento.",
      ),
    );
  }

  if (amountArsCents > MAX_CHARGED_AMOUNT_CENTS) {
    return err(
      appError(
        "price_out_of_range",
        "El precio en pesos quedó fuera de lo que podemos cobrar. " +
          "No se abrió ninguna suscripción.",
      ),
    );
  }

  const session = await createPreapproval({
    subscriptionId: subscriptionId.value,
    reason: `Turnos — plan ${planLabel(plan)}`,
    payerEmail,
    amountArsCents,
    backUrl,
  });
  if (!session.ok) return session;

  // `service_role` Y función SECURITY DEFINER, no una de las dos: `subscriptions`
  // no tiene política de escritura de RLS, y ese hueco es la decisión — un dueño
  // que pudiera hacer UPDATE sobre su suscripción se pondría en premium.
  //
  // TODO EL BLOQUE va dentro del `try`, incluida la creación del cliente.
  // Preguntar sólo por `stamped.error` mira nada más el fallo que PostgREST
  // DEVUELVE, y deja afuera el que TIRA: `createAdminClient()` revienta si falta
  // la service-role key, y la llamada puede rechazar por red. Una excepción acá
  // se escapa de la función y el dueño ve un crash genérico justo en el único
  // momento en que hay algo abierto en Mercado Pago a su nombre — que es
  // exactamente el aviso que este error existe para darle. Es el mismo
  // aprendizaje que ya estaba escrito en `queries.ts` y que acá faltaba aplicar.
  let stamped: { data: unknown; error: unknown };
  try {
    const admin = createAdminClient();
    stamped = await admin.rpc("attach_subscription_checkout", {
      p_tenant_id: tenantId,
      p_subscription_id: subscriptionId.value,
      p_plan: plan,
      p_price_usd_cents: priceUsdCents,
      p_charged_amount_cents: amountArsCents,
      p_fx_rate: quote.value.rate,
      p_fx_source: quote.value.source,
      p_fx_quoted_at: quote.value.quotedAt.toISOString(),
      p_provider: PROVIDER,
      p_provider_subscription_id: session.value.providerSubscriptionId,
    });
  } catch {
    return notStamped();
  }

  // `data: false` es un NO explícito de la función: no tocó ninguna fila porque
  // la suscripción no es de este negocio o ya está cancelada. Tratarlo como
  // éxito dejaría al dueño creyendo que contrató algo.
  if (stamped.error || stamped.data !== true) return notStamped();

  return ok({ initPoint: session.value.initPoint });
}
