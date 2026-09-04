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

/**
 * ¿El negocio puede recibir turnos NUEVOS?
 *
 * Es la única pregunta que decide si se le muestra el formulario de reserva,
 * en el panel y en la página pública. No decide nada más: la agenda que ya
 * tiene se sigue viendo, cerrando y reprogramando. Perder turnos ya tomados
 * —o no poder avisarle a un cliente que no lo pueden atender— sería un daño
 * al cliente del negocio por una deuda del negocio.
 *
 * `null` es NO, y conviene decir por qué no es una decisión conservadora al
 * voleo: `create_business` abre la suscripción en la misma transacción que el
 * negocio, y `20260817120002` le dio una a cada negocio que ya existía. Un
 * negocio sin suscripción viva no es un negocio nuevo, es un estado roto.
 *
 * ESTA FUNCIÓN NO ES EL FRENO. El freno vive en `create_booking()`, del lado
 * de la base — `create_booking` sigue grantada a `authenticated`, así que un
 * dueño logueado le puede pegar a PostgREST directo y saltearse todo este
 * archivo. Acá se decide qué MOSTRAR; allá se decide qué ENTRA. Las dos tienen
 * que dar la misma respuesta o el dueño llena un formulario para que la base
 * se lo rechace. Ver `public.tenant_takes_bookings()`.
 */
export function takesNewBookings(
  subscription: TrialView | null,
  now: Date,
): boolean {
  if (!subscription) return false;

  // La prueba se mide por la FECHA, no por la etiqueta: nada mueve el estado
  // de `trialing` cuando se cumple el plazo. Ver `isInTrial`.
  if (subscription.status === "trialing") return isInTrial(subscription, now);

  // `past_due` entra: el cobro falló pero Mercado Pago lo sigue reintentando y
  // el servicio anda durante la gracia. Espeja `LIVE_STATUSES`.
  return subscription.status === "active" || subscription.status === "past_due";
}
