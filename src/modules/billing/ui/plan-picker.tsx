"use client";

import { useActionState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { type ActionState, idleState } from "@/core/action";
import type { PlanTier } from "@/modules/tenants/domain/types";

/**
 * Un plan tal como se muestra. TODO viene ya resuelto desde el servidor.
 *
 * El precio llega FORMATEADO y no en centavos a propósito: `formatPrice` es de
 * catálogo y este componente es de cobro. Pasarlo hecho deja al picker sin una
 * sola decisión sobre plata, que es lo que hace que se pueda probar mirando
 * texto y no aritmética.
 */
export interface PlanOption {
  plan: PlanTier;
  label: string;
  priceUsd: string;
  staff: number;
  whatsappMessages: number;
  bookingsPerMonth: number;
}

interface PlanPickerProps {
  options: PlanOption[];
  /** El plan que el negocio USA hoy. Sale de `tenants.plan`. */
  currentPlan: PlanTier;
  /**
   * Si ese plan se está COBRANDO. No es lo mismo que tenerlo: durante la
   * prueba `tenants.plan` ya dice `basico` y no hay ningún cobro abierto.
   */
  paying: boolean;
  start: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

/**
 * Los planes, y el botón que abre el cobro.
 *
 * Presentacional: no sabe de Supabase ni de Mercado Pago. La action entra por
 * prop, así que probarlo no necesita ni red ni base.
 *
 * UN SOLO `useActionState` para los tres formularios, y no uno por tarjeta.
 * Esa es la parte que importa: `pending` es compartido, así que apretar
 * "Contratar Pro" deja los tres botones bloqueados. Con un estado por tarjeta,
 * alguien apura y abre Pro y Premium — dos suscripciones en Mercado Pago, las
 * dos cobrando, y el `external_reference` apuntando a la misma fila nuestra.
 */
export function PlanPicker({
  options,
  currentPlan,
  paying,
  start,
}: PlanPickerProps) {
  const [state, action, pending] = useActionState(start, idleState);

  return (
    <div>
      {state.status === "error" && (
        <p className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {options.map((option) => {
          const isCurrent = option.plan === currentPlan;
          // Sólo se bloquea si ADEMÁS se está cobrando. Ver `paying`.
          const locked = isCurrent && paying;

          return (
            <Card key={option.plan} className="flex flex-col p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-lg font-semibold tracking-tight">
                  {option.label}
                </h3>
                {isCurrent && <Badge variant="gold">Tu plan</Badge>}
              </div>

              <p className="mt-3 font-display text-2xl font-semibold tracking-tight">
                {option.priceUsd}
              </p>
              <p className="text-sm text-faint">por mes</p>

              <ul className="mt-4 flex-1 space-y-2 text-sm text-muted">
                <Feature>
                  {option.staff}{" "}
                  {option.staff === 1 ? "profesional" : "profesionales"}
                </Feature>
                <Feature>
                  {option.whatsappMessages > 0
                    ? `${option.whatsappMessages} mensajes de WhatsApp`
                    : "Sin WhatsApp"}
                </Feature>
                <Feature>
                  Hasta {option.bookingsPerMonth} turnos por mes
                </Feature>
              </ul>

              <form action={action} className="mt-5">
                <input type="hidden" name="plan" value={option.plan} />
                <Button
                  type="submit"
                  variant={isCurrent ? "outline" : "primary"}
                  className="w-full"
                  // `pending` bloquea TODOS, no sólo el que se apretó.
                  disabled={locked || pending}
                >
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  {locked ? "Plan actual" : `Contratar ${option.label}`}
                </Button>
              </form>
            </Card>
          );
        })}
      </div>

      {/* El precio está en dólares y el cobro sale en pesos a la cotización del
          día (ver `fx.ts`). Callarlo convierte el resumen de la tarjeta en una
          sorpresa, y una sorpresa sobre plata es un reclamo al banco. */}
      <p className="mt-4 text-sm text-faint">
        Los precios están en dólares y se cobran en pesos a la cotización del
        día. El monto exacto se te muestra en Mercado Pago antes de confirmar.
      </p>
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 size-4 shrink-0 text-gold" />
      <span>{children}</span>
    </li>
  );
}
