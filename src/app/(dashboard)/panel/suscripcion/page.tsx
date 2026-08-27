import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ArrowLeft } from "lucide-react";

import { Card } from "@/components/ui/card";
import { startCheckoutAction } from "@/modules/billing/application/actions";
import { getCurrentSubscription } from "@/modules/billing/application/queries";
import { limitsFor, planLabel } from "@/modules/billing/domain/plan";
import { priceUsdCentsFor } from "@/modules/billing/domain/price";
import {
  isInTrial,
  trialDaysLeft,
} from "@/modules/billing/domain/subscription";
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

  if (!tenant) redirect("/panel/bienvenida");

  const subscription = await getCurrentSubscription(tenant.id);
  const now = new Date();

  // `getCurrentSubscription` devuelve null tanto si no hay suscripción como si
  // la base no contestó, y acá esa diferencia no cambia nada: en los dos casos
  // se muestran los planes. Dejar al dueño sin forma de pagar por un fallo de
  // lectura sería peor que mostrarle un estado incompleto.
  const paying = subscription
    ? PAYING_STATUSES.has(subscription.status)
    : false;

  const trialDays =
    subscription && isInTrial(subscription, now)
      ? trialDaysLeft(subscription, now)
      : 0;

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

        {trialDays > 0 && (
          <p className="mt-2 text-sm text-muted">
            Prueba gratis · te quedan {trialDays}{" "}
            {trialDays === 1 ? "día" : "días"}. Todavía no se te cobró nada.
          </p>
        )}

        {paying && subscription && (
          <p className="mt-2 text-sm text-muted">
            Próximo cobro:{" "}
            {format(subscription.currentPeriodEnd, "d 'de' MMMM", {
              locale: es,
            })}
          </p>
        )}
      </Card>

      <h2 className="mt-8 mb-3 font-display text-lg font-semibold tracking-tight">
        {paying ? "Cambiar de plan" : "Elegí tu plan"}
      </h2>

      <PlanPicker
        options={options}
        currentPlan={tenant.plan}
        paying={paying}
        start={startCheckoutAction}
      />
    </div>
  );
}
