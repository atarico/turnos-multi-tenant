import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ArrowLeft, Gift } from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  cancelSubscriptionAction,
  startCheckoutAction,
} from "@/modules/billing/application/actions";
import {
  countPeriodBookings,
  getCurrentSubscription,
} from "@/modules/billing/application/queries";
import {
  bookingCeilingState,
  limitsFor,
  planLabel,
} from "@/modules/billing/domain/plan";
import { priceUsdCentsFor } from "@/modules/billing/domain/price";
import {
  isInTrial,
  trialDaysLeft,
} from "@/modules/billing/domain/subscription";
import { CancelSubscription } from "@/modules/billing/ui/cancel-subscription";
import { PlanPicker, type PlanOption } from "@/modules/billing/ui/plan-picker";
import { formatPrice } from "@/modules/catalog/domain/money";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import type { PlanTier } from "@/modules/tenants/domain/types";

export const metadata: Metadata = { title: "Suscripción" };

/** El orden en que se muestran. De menor a mayor, que es como se lee un precio. */
const PLANS: PlanTier[] = ["basico", "pro", "premium"];

/**
 * Los estados en los que YA HAY un cobro abierto contra Mercado Pago.
 *
 * `past_due` está adentro y no es un descuido: el cobro falló pero la
 * suscripción sigue viva y Mercado Pago la sigue reintentando. Contratar otra
 * encima abriría un segundo preapproval que también cobra, y el negocio
 * terminaría pagando dos veces por el mismo mes.
 *
 * `trialing` NO está: durante la prueba `tenants.plan` ya dice un plan pero no
 * hay nada cobrando, y bloquear ahí dejaría al negocio sin forma de empezar a
 * pagar.
 */
const PAYING_STATUSES = new Set(["active", "past_due"]);

interface SuscripcionPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function SuscripcionPage({
  searchParams,
}: SuscripcionPageProps) {
  const { preapproval_id: preapprovalId } = await searchParams;
  const tenant = await getCurrentTenant();

  // Al panel, no a la bienvenida: adónde va una cuenta sin negocio tiene dos
  // respuestas —recién registrado, u operador de plataforma— y esa decisión
  // vive en un solo lugar. Saltearla acá mandaría al operador a crear un
  // negocio. Es lo mismo que hacen /servicios, /profesionales y /configuración.
  if (!tenant) redirect("/panel");

  const subscription = await getCurrentSubscription(tenant.id);
  const now = new Date();

  // `getCurrentSubscription` devuelve null tanto si no hay suscripción como si
  // la base no contestó, y acá esa diferencia no cambia nada: en los dos casos
  // se muestran los planes. Dejar al dueño sin forma de pagar por un fallo de
  // lectura sería peor que mostrarle un estado incompleto.
  const paying = subscription
    ? PAYING_STATUSES.has(subscription.status)
    : false;

  // Hay una cortesía EN EFECTO cuando lo que el negocio puede usar difiere de
  // lo que paga. No hace falta mirar la fecha: `getCurrentTenant` ya descartó
  // las vencidas, y una cortesía que no mejora nada no tiene nada que anunciar.
  const courtesy = tenant.plan !== tenant.paid_plan;

  const trialDays =
    subscription && isInTrial(subscription, now)
      ? trialDaysLeft(subscription, now)
      : 0;

  /**
   * Hasta cuándo sigue tomando turnos, en la zona del NEGOCIO.
   *
   * Es una fecha sobre la que el dueño va a tomar una decisión —dar de baja o
   * no—, y en el borde del mes la zona del servidor y la suya caen en meses
   * distintos. Mismo criterio que el "próximo cobro" de más arriba: un
   * INSTANTE se cuenta desde donde está parado el que lo mira.
   */
  const servesUntil = subscription
    ? format(
        new TZDate(subscription.currentPeriodEnd, tenant.timezone),
        "d 'de' MMMM",
        { locale: es },
      )
    : "";

  // Sólo se ofrece la baja cuando hay un cobro que cortar. Durante la prueba
  // no hay ninguno —nada la convierte sola, el checkout es manual—, así que un
  // botón que promete "no se te va a cobrar más" contestaría una pregunta que
  // nadie hizo.
  const canCancel = paying;

  const canceled = subscription?.status === "canceled";
  // Y una baja con el período todavía corriendo NO es lo mismo que una vencida:
  // en la primera sigue entrando trabajo, en la segunda no. Decir lo mismo en
  // las dos es mentirle a una de las dos.
  const stillServed =
    canceled && subscription.currentPeriodEnd.getTime() > now.getTime();

  // El techo se mide contra el período de la suscripción, no contra el mes
  // civil: es la ventana que el negocio efectivamente pagó, y arranca el día
  // que entró el cobro. Sin suscripción no hay período contra el cual medir.
  //
  // `null` (no se pudo contar) NO es cero: abajo apaga el aviso en vez de
  // decirle al dueño que va tranquilo. Ver `countPeriodBookings`.
  const bookingsLoaded = subscription
    ? await countPeriodBookings(
        tenant.id,
        subscription.currentPeriodStart.toISOString(),
        subscription.currentPeriodEnd.toISOString(),
      )
    : null;

  // El plan EFECTIVO, cortesía incluida: un negocio con premium de regalo
  // tiene el techo de premium. Medirlo contra el plan pagado le avisaría a los
  // 300 teniendo 5.000 disponibles.
  const bookingCeiling = limitsFor(tenant.plan).bookingsPerMonth;
  const ceilingState =
    bookingsLoaded === null
      ? null
      : bookingCeilingState(tenant.plan, bookingsLoaded);

  const options: PlanOption[] = PLANS.map((plan) => {
    const limits = limitsFor(plan);
    return {
      plan,
      label: planLabel(plan),
      // Formateado ACÁ, en el servidor. El picker no hace una sola cuenta con
      // plata: ver la nota en `PlanOption`.
      priceUsd: formatPrice(priceUsdCentsFor(plan), "USD"),
      staff: limits.staff,
      whatsappMessages: limits.whatsappMessages,
      bookingsPerMonth: limits.bookingsPerMonth,
    };
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <Link
        href="/panel"
        className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Volver al panel
      </Link>

      <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">
        Suscripción
      </h1>

      {/* VOLVER DEL CHECKOUT NO ES HABER PAGADO.
          Mercado Pago redirige acá apenas la persona termina de cargar la
          tarjeta, y el cobro puede tardar o no entrar nunca. Quien activa es el
          webhook. Decir "listo, ya está" en base a este parámetro sería mentir
          — y encima cualquiera lo pone a mano en la URL. */}
      {preapprovalId && (
        <p className="mt-4 rounded-xl border border-gold/30 bg-gold/10 px-3.5 py-3 text-sm text-foreground">
          Recibimos tu suscripción. La activación se confirma cuando Mercado
          Pago nos avise que el cobro entró, y eso puede tardar unos minutos.
          Vas a ver el plan nuevo acá mismo.
        </p>
      )}

      {/* LA BAJA, CONTADA. Sin este cartel el dueño que canceló entra una
          semana después y no encuentra un solo rastro de lo que hizo — y si
          además le quedaba mes pago, cree que lo perdió. */}
      {canceled && (
        <p className="mt-4 rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-sm text-muted">
          {stillServed ? (
            <>
              Diste de baja tu suscripción, así que no se te va a cobrar más.
              Seguís tomando turnos hasta el <b>{servesUntil}</b>, y tu agenda
              queda intacta.
            </>
          ) : (
            <>
              Diste de baja tu suscripción y el período que habías pagado
              terminó, así que <b>no estás tomando turnos nuevos</b>. Tu agenda
              sigue ahí: podés verla, cerrarla y reprogramarla. Para volver a
              recibir reservas, elegí un plan.
            </>
          )}
        </p>
      )}

      {subscription?.status === "past_due" && (
        <p className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-sm text-danger">
          No pudimos cobrar tu último mes. El servicio sigue andando mientras
          Mercado Pago reintenta; revisá el medio de pago para no quedarte sin
          el plan.
        </p>
      )}

      <Card className="mt-6 p-5">
        <p className="text-sm text-muted">Tu plan hoy</p>
        <p className="mt-1 font-display text-xl font-semibold tracking-tight">
          {planLabel(tenant.plan)}
        </p>

        {/* Un plan mejor sin explicación se lee como algo comprado, y el día
            que caduca el negocio cree que le sacaron lo que pagó. Las dos
            preguntas que tiene que poder contestar son por qué lo tiene y qué
            pasa cuando se termine: las dos se contestan acá. */}
        {courtesy && (
          <p className="mt-2 flex items-start gap-2 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-sm text-foreground">
            <Gift className="mt-0.5 size-4 shrink-0 text-gold" />
            <span>
              Es una <b>cortesía</b> de la plataforma, no un plan contratado.
              {tenant.plan_courtesy_until
                ? ` Va hasta el ${format(
                    // En UTC, que es la zona en la que se guardó. La fecha la
                    // elige el operador con un selector de día y se almacena
                    // como medianoche UTC: leída en hora local del servidor,
                    // cae el día ANTERIOR y el dueño ve un vencimiento que no
                    // es el que se pactó.
                    new TZDate(new Date(tenant.plan_courtesy_until), "UTC"),
                    "d 'de' MMMM",
                    { locale: es },
                  )}`
                : " No tiene fecha de fin"}
              , y cuando termine tu cuenta vuelve a{" "}
              {planLabel(tenant.paid_plan)}.
            </span>
          </p>
        )}

        {trialDays > 0 && (
          <p className="mt-2 text-sm text-muted">
            Prueba gratis · te quedan {trialDays}{" "}
            {trialDays === 1 ? "día" : "días"}. Todavía no se te cobró nada.
          </p>
        )}

        {paying && subscription && (
          <p className="mt-2 text-sm text-muted">
            Próximo cobro:{" "}
            {/* En la zona horaria DEL NEGOCIO, no en la del servidor. Es una
                fecha sobre plata: el dueño la lee para saber cuándo le
                descuentan, y en el borde del mes las dos lecturas caen en
                meses distintos. La cortesía de arriba se pinta en UTC y no acá
                — no es una inconsistencia: aquélla es un día de calendario que
                eligió el operador, ésta es un INSTANTE, y un instante se cuenta
                desde donde está parado el que lo mira. */}
            {format(
              new TZDate(subscription.currentPeriodEnd, tenant.timezone),
              "d 'de' MMMM",
              { locale: es },
            )}
          </p>
        )}

        {/* EL TECHO NO BLOQUEA NADA. Es un freno anti-abuso puesto tan alto
            que un negocio normal no lo toca, y llegar arriba no impide que
            nadie reserve: al único que hay que avisarle es al dueño, que es
            quien eligió el plan. Por eso el caso `over` aclara explícitamente
            que la agenda sigue abierta — sin esa frase, el dueño sale a apagar
            un incendio que no existe. */}
        {ceilingState !== null && bookingsLoaded !== null && (
          <p
            className={
              ceilingState === "under"
                ? "mt-2 text-sm text-muted"
                : "mt-2 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-sm text-foreground"
            }
          >
            Cargaste <b>{bookingsLoaded}</b> de {bookingCeiling} turnos de tu
            plan en este período.
            {ceilingState === "near" && " Te queda poco margen."}
            {ceilingState === "over" &&
              " Tus clientes siguen pudiendo reservar con normalidad — el tope" +
                " es nuestro, no de ellos. Si se repite, conviene mirar un plan" +
                " más grande."}
          </p>
        )}
      </Card>

      <h2 className="mt-8 mb-3 font-display text-lg font-semibold tracking-tight">
        {paying ? "Cambiar de plan" : "Elegí tu plan"}
      </h2>

      <PlanPicker
        options={options}
        // Lo que se PAGA, no lo efectivo: marcar la cortesía acá la mostraría
        // como contratada y —con un cobro abierto— la bloquearía, dejando al
        // negocio sin poder cambiar de plan. El regalo se explica arriba.
        currentPlan={tenant.paid_plan}
        paying={paying}
        start={startCheckoutAction}
      />

      {/* Al final y sin destacar, que es donde va la salida: tiene que estar
          y tiene que encontrarse, no tiene que competir con los planes. */}
      {canCancel && (
        <CancelSubscription
          cancel={cancelSubscriptionAction}
          servesUntil={servesUntil}
        />
      )}
    </div>
  );
}
