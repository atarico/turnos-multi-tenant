import type { PlanTier } from "@/modules/tenants/domain/types";

import { betterPlan } from "./plan";

/** Lo mínimo que hace falta para responder por la cortesía. */
export interface CourtesyView {
  /** Lo que el negocio PAGA. Columna `tenants.plan`, dueña del webhook. */
  plan: PlanTier;
  /** Lo que un operador le REGALÓ, o `null`. */
  planCourtesy: PlanTier | null;
  /** Hasta cuándo dura el regalo. `null` = hasta que lo saquen. */
  planCourtesyUntil: Date | null;
}

/**
 * El plan que el negocio puede USAR ahora mismo.
 *
 * Son dos columnas y no una porque son dos hechos distintos: `plan` es lo que
 * la pasarela cobra —y lo pisa el webhook en cada renovación— mientras que la
 * cortesía es lo que un humano decidió regalar. Guardar el regalo encima de
 * `plan` lo haría desaparecer solo en la próxima renovación, sin dejar rastro
 * de que alguna vez existió.
 *
 * ## Por qué se calcula al LEER y no al otorgar
 *
 * Por el vencimiento. En este proyecto no corre ninguna tarea agendada que
 * pueda apagar una cortesía el día que corresponde. Si el regalo se escribiera
 * en `tenants.plan` al otorgarlo, nadie lo apagaría nunca: una cortesía de tres
 * meses sería una cortesía para siempre por olvido. Calculado al leer, caduca
 * solo, sin infraestructura.
 *
 * De paso, `tenants.plan` sigue significando honestamente "lo que este negocio
 * paga", que es lo que hace que la comparación contra la suscripción del panel
 * de plataforma siga queriendo decir algo.
 *
 * ## Un regalo nunca empeora
 *
 * Si la cortesía vale MENOS que lo que el negocio ya compró, no cambia nada. Un
 * operador que se equivoca de fila y le regala `basico` a alguien que paga
 * `premium` no puede dejarlo peor de lo que estaba: le sacaría profesionales
 * activos por los que ya pagó, y el negocio se enteraría cuando no pueda
 * trabajar.
 */
export function effectivePlan(tenant: CourtesyView, now: Date): PlanTier {
  if (!tenant.planCourtesy) return tenant.plan;

  const expired =
    tenant.planCourtesyUntil !== null &&
    tenant.planCourtesyUntil.getTime() <= now.getTime();

  if (expired) return tenant.plan;

  return betterPlan(tenant.plan, tenant.planCourtesy);
}
