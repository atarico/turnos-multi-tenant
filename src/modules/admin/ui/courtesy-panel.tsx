"use client";

import { useActionState } from "react";
import { Gift, Trash2 } from "lucide-react";

import { type ActionState, idleState } from "@/core/action";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { planLabel } from "@/modules/billing/domain/plan";
import type { PlanCourtesy } from "@/modules/admin/domain/types";
import type { PlanTier } from "@/modules/tenants/domain/types";

const PLANS: PlanTier[] = ["basico", "pro", "premium"];

interface CourtesyPanelProps {
  tenantId: string;
  slug: string;
  /** El plan que el negocio PAGA. Se muestra para que el regalo se elija sabiendo. */
  paidPlan: PlanTier;
  courtesy: PlanCourtesy | null;
  grant: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  revoke: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

export function CourtesyPanel({
  tenantId,
  slug,
  paidPlan,
  courtesy,
  grant,
  revoke,
}: CourtesyPanelProps) {
  const [grantState, grantAction, granting] = useActionState(grant, idleState);
  const [revokeState, revokeAction, revoking] = useActionState(
    revoke,
    idleState,
  );

  const state = courtesy ? revokeState : grantState;

  return (
    <Card className="mt-6 p-5">
      <div className="flex items-center gap-2">
        <Gift className="size-4 text-gold" />
        <h2 className="font-display text-base font-semibold tracking-tight">
          Cortesía
        </h2>
      </div>

      {courtesy ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="gold">{planLabel(courtesy.plan)}</Badge>
            <span className="text-sm text-muted">
              {courtesy.until
                ? `hasta el ${courtesy.until.slice(0, 10)}`
                : "sin vencimiento"}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">{courtesy.reason}</p>

          <form action={revokeAction} className="mt-4">
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="slug" value={slug} />
            <button
              disabled={revoking}
              className="inline-flex items-center gap-2 rounded-lg border border-danger/30 px-3 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              <Trash2 className="size-4" />
              {revoking ? "Quitando…" : "Quitar la cortesía"}
            </button>
          </form>
        </div>
      ) : (
        <form action={grantAction} className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="slug" value={slug} />

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">Plan a regalar</span>
            <select
              name="plan"
              defaultValue="premium"
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            >
              {PLANS.map((plan) => (
                <option key={plan} value={plan}>
                  {planLabel(plan)}
                </option>
              ))}
            </select>
          </label>

          {/* Se dice lo que paga para que el operador no regale hacia abajo
              creyendo que sube. Aunque lo haga, no puede empeorarlo: el plan
              efectivo es el mejor de los dos. */}
          <p className="text-sm text-muted">
            Hoy paga <b>{planLabel(paidPlan)}</b>. Una cortesía menor no le
            cambia nada.
          </p>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">Motivo</span>
            <input
              name="reason"
              placeholder="Beta tester, compensación, trato cerrado por afuera…"
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            />
            {state.status === "error" && state.fieldErrors?.reason ? (
              <span className="text-sm text-danger">
                {state.fieldErrors.reason}
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-muted">
              Hasta (opcional — vacío es hasta que la saques)
            </span>
            <input
              type="date"
              name="until"
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            />
          </label>

          <button
            disabled={granting}
            className="mt-1 inline-flex w-fit items-center gap-2 rounded-lg bg-gold/15 px-3.5 py-2 text-sm text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
          >
            <Gift className="size-4" />
            {granting ? "Otorgando…" : "Otorgar"}
          </button>
        </form>
      )}

      {state.status === "error" ? (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      ) : null}
    </Card>
  );
}
