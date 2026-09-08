"use client";

import { useActionState } from "react";
import { Ticket } from "lucide-react";

import { type ActionState, idleState } from "@/core/action";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  couponState,
  discountLabel,
  type Coupon,
  type CouponState,
} from "@/modules/admin/domain/coupon";

/**
 * El estado se dice con palabras y color, no sólo con color: un cupón "apagado"
 * y uno "agotado" no se arreglan igual, y distinguirlos por el tono del badge
 * deja afuera a cualquiera que no distinga esos dos tonos.
 */
const STATE_LABELS: Record<CouponState, string> = {
  active: "Activo",
  off: "Apagado",
  expired: "Vencido",
  exhausted: "Agotado",
};

const STATE_VARIANTS: Record<CouponState, "gold" | "muted" | "danger"> = {
  active: "gold",
  off: "muted",
  expired: "danger",
  exhausted: "danger",
};

interface CouponAdminProps {
  coupons: Coupon[];
  /** El instante contra el que se decide qué venció. Viene del servidor. */
  now: string;
  create: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  toggle: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

export function CouponAdmin({ coupons, now, create, toggle }: CouponAdminProps) {
  const [createState, createAction, creating] = useActionState(
    create,
    idleState,
  );
  const [toggleState, toggleAction] = useActionState(toggle, idleState);
  const nowDate = new Date(now);

  return (
    <>
      <Card className="mt-6 p-5">
        <h2 className="font-display text-base font-semibold tracking-tight">
          Crear un cupón
        </h2>

        <form action={createAction} className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Código" error={fieldError(createState, "code")}>
            <input
              name="code"
              placeholder="BETA99"
              autoCapitalize="characters"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm uppercase"
            />
          </Field>

          {/* Se pide en porcentaje, no en puntos básicos: nadie escribe 9900
              queriendo decir 99, y pedir bps traslada al operador una decisión
              de precisión que se tomó adentro de la base. */}
          <Field label="Descuento (%)" error={fieldError(createState, "percent")}>
            <input
              name="percent"
              type="number"
              step="0.01"
              min="0.01"
              max="99"
              placeholder="99"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            />
          </Field>

          <Field
            label="Vence (opcional)"
            error={fieldError(createState, "expiresAt")}
          >
            <input
              name="expiresAt"
              type="date"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            />
          </Field>

          <Field
            label="Tope de usos (opcional)"
            error={fieldError(createState, "maxRedemptions")}
          >
            <input
              name="maxRedemptions"
              type="number"
              min="1"
              placeholder="sin tope"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Para qué es" error={fieldError(createState, "note")}>
              <input
                name="note"
                placeholder="Prueba de cobro real, campaña de verano…"
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <button
            disabled={creating}
            className="w-fit rounded-lg bg-gold/15 px-3.5 py-2 text-sm text-gold transition-colors hover:bg-gold/25 disabled:opacity-50"
          >
            {creating ? "Creando…" : "Crear cupón"}
          </button>
        </form>

        {createState.status === "error" ? (
          <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {createState.message}
          </p>
        ) : null}
      </Card>

      {toggleState.status === "error" ? (
        <p className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {toggleState.message}
        </p>
      ) : null}

      {coupons.length === 0 ? (
        <Card className="mt-6 px-6 py-10 text-center">
          <Ticket className="mx-auto size-6 text-faint" />
          <p className="mt-3 text-sm text-muted">Todavía no hay cupones.</p>
        </Card>
      ) : (
        <ul className="mt-6 space-y-3">
          {coupons.map((coupon) => {
            const state = couponState(coupon, nowDate);
            return (
              <li key={coupon.code}>
                <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono text-sm font-semibold">
                        {coupon.code}
                      </span>
                      <Badge variant="info">
                        {discountLabel(coupon.discount_bps)}
                      </Badge>
                      <Badge variant={STATE_VARIANTS[state]}>
                        {STATE_LABELS[state]}
                      </Badge>
                    </div>
                    {coupon.note ? (
                      <p className="mt-1 text-sm text-muted">{coupon.note}</p>
                    ) : null}
                    <p className="mt-1 text-sm text-faint">
                      {coupon.redemptions}
                      {coupon.max_redemptions === null
                        ? " usos · sin tope"
                        : ` de ${coupon.max_redemptions} usos`}
                      {coupon.expires_at
                        ? ` · vence ${coupon.expires_at.slice(0, 10)}`
                        : ""}
                    </p>
                  </div>

                  {/* El estado deseado viaja en el form y no se deduce del
                      actual: dos clicks seguidos leerían el mismo valor y el
                      segundo desharía al primero sin que nadie lo pidiera. */}
                  <form action={toggleAction}>
                    <input type="hidden" name="code" value={coupon.code} />
                    <input
                      type="hidden"
                      name="active"
                      value={String(!coupon.active)}
                    />
                    <button className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground">
                      {coupon.active ? "Apagar" : "Encender"}
                    </button>
                  </form>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function fieldError(state: ActionState, name: string): string | undefined {
  return state.status === "error" ? state.fieldErrors?.[name] : undefined;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </label>
  );
}
