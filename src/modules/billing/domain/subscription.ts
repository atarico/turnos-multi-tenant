import type { PlanTier } from "@/modules/tenants/domain/types";

/**
 * Estado de cobro de la suscripción. Espeja el enum `subscription_status`.
 *
 * `past_due` es su propio estado y no un `active` con una bandera: el cobro
 * falló pero el servicio sigue andando durante la gracia. Colapsarlo contra
 * `active` haría imposible saber a quién avisarle.
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

/** Una suscripción. Espeja la tabla `public.subscriptions`. */
export interface Subscription {
  id: string;
  tenantId: string;
  plan: PlanTier;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  priceUsdCents: number;
  chargedAmountCents: number | null;
  chargedCurrency: string;
  fxRate: number | null;
  fxSource: string | null;
  fxQuotedAt: Date | null;
}

/**
 * Cuánto dura la prueba NO se decide acá.
 *
 * Lo fija `create_business` con `now() + interval '14 days'` al crear el
 * negocio, y desde entonces la verdad es la fecha guardada en `trial_ends_at`.
 * Tener acá una constante con el mismo 14 sería un segundo lugar que puede
 * quedar desincronizado sin que nada falle, y nadie la leería: todo lo de
 * abajo trabaja sobre la fecha, no sobre la duración.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Lo mínimo que hace falta para responder por la prueba. */
type TrialView = Pick<Subscription, "status" | "trialEndsAt">;

/**
 * ¿Está corriendo la prueba gratis?
 *
 * Pide las dos cosas: que el estado sea `trialing` Y que la fecha no haya
 * pasado. El estado lo mueve el cobro y la fecha la mueve el reloj, así que
 * entre el vencimiento y el webhook hay una ventana donde no coinciden.
 * Mandan los hechos, no la etiqueta.
 */
export function isInTrial(subscription: TrialView, now: Date): boolean {
  if (subscription.status !== "trialing") return false;
  if (!subscription.trialEndsAt) return false;
  return subscription.trialEndsAt.getTime() > now.getTime();
}

/**
 * Días que le quedan de prueba, para mostrarle al dueño.
 *
 * Redondea PARA ARRIBA: a quien le quedan 18 horas le queda "1 día", no cero.
 * Mostrar cero mientras el servicio todavía anda es mentirle.
 */
export function trialDaysLeft(subscription: TrialView, now: Date): number {
  if (!isInTrial(subscription, now)) return 0;

  const remaining = subscription.trialEndsAt!.getTime() - now.getTime();
  return Math.ceil(remaining / MS_PER_DAY);
}
