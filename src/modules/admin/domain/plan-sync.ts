import type { Subscription } from "@/modules/billing/domain/subscription";
import type { PlanTier } from "@/modules/tenants/domain/types";

/**
 * ¿El plan que el negocio TIENE y el que su suscripción PAGA son el mismo?
 *
 * Son dos columnas en dos tablas y nada en la base las obliga a coincidir:
 * `tenants.plan` es lo que rige el acceso, `subscriptions.plan` es lo que se
 * pactó con la pasarela. El webhook mueve las dos, pero cualquier camino que
 * toque una sola las separa.
 *
 * No es hipotético: pasó en el sandbox. Un segundo checkout dejó al negocio
 * mostrando un plan mientras el preapproval que realmente cobraba era de otro,
 * y desde el panel se veía un negocio perfectamente normal. Esa clase de falla
 * es invisible salvo que alguien ponga las dos columnas una al lado de la otra
 * —que es exactamente lo que hace el detalle del negocio.
 *
 * Dos estados quedan afuera a propósito, por motivos espejo:
 *
 *   · CANCELADA: su plan es historia, no una promesa vigente. Alguien que
 *     cancela premium y cae a básico deja este mismo cuadro y está bien.
 *   · SIN CONFIRMAR (`incomplete`): su plan no es historia, es una INTENCIÓN.
 *     Es la fila que abre el re-alta con el plan que el dueño acaba de
 *     apretar, mientras `tenants.plan` sigue siendo el que tenía porque
 *     todavía no entró un peso. Las dos columnas dicen la verdad.
 *
 * Sin estas dos ramas, todo negocio que alguna vez bajó de plan —y todo dueño
 * que abandona el checkout, que son muchos— quedaría marcado, y una alarma que
 * suena cuando no pasa nada deja de mirarse: el día que la discrepancia sea
 * real, nadie la ve.
 */
export function planIsOutOfSync(
  tenantPlan: PlanTier,
  subscription: Pick<Subscription, "plan" | "status"> | null,
): boolean {
  if (!subscription) return false;
  if (subscription.status === "canceled") return false;
  if (subscription.status === "incomplete") return false;
  return subscription.plan !== tenantPlan;
}
