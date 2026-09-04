"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { type ActionState, idleState } from "@/core/action";

interface CancelSubscriptionProps {
  cancel: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  /**
   * Hasta cuándo sigue tomando turnos, ya formateado. Llega hecho desde el
   * servidor por lo mismo que el precio del picker: la fecha va en la zona del
   * NEGOCIO, y esa cuenta no se hace en el navegador de quien mira.
   */
  servesUntil: string;
}

/**
 * Dar de baja la suscripción.
 *
 * DOS PASOS a propósito. Es el único botón del panel que corta un cobro, y del
 * otro lado hay una suscripción cancelada en Mercado Pago que no se deshace
 * con un ctrl+Z. Un solo botón suelto entre los planes se aprieta por error.
 *
 * Y la confirmación no pregunta "¿estás seguro?", que no le dice nada a nadie:
 * dice lo que va a pasar. Las dos frases que importan son que no se cobra más
 * y que NO se pierde lo pagado — sin la segunda, el que quiere irse a fin de
 * mes no se anima a apretar hoy, y el que aprieta cree que perdió el mes.
 *
 * Presentacional: no sabe de Supabase ni de Mercado Pago. La action entra por
 * prop, así que probarlo no necesita red.
 */
export function CancelSubscription({
  cancel,
  servesUntil,
}: CancelSubscriptionProps) {
  const [state, action, pending] = useActionState(cancel, idleState);
  const [confirming, setConfirming] = useState(false);

  // Dada de baja, no hay nada más que ofrecer. Dejar el botón invitaría a
  // apretar de nuevo sobre algo ya hecho: la base lo aguanta —devuelve
  // `already_canceled`— pero le haría creer al dueño que la primera vez no
  // funcionó.
  if (state.status === "success") {
    return (
      <p className="mt-8 rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-sm text-muted">
        {state.message} Seguís tomando turnos hasta el {servesUntil}.
      </p>
    );
  }

  return (
    <div className="mt-8 border-t border-border pt-6">
      {state.status === "error" && (
        <p className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}

      {!confirming ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            ¿No querés seguir? Podés dar de baja cuando quieras.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Dar de baja
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface-2 px-5 py-4">
          <p className="text-sm font-medium text-foreground">
            Vas a dar de baja tu suscripción.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            No se te va a cobrar nunca más. <b>No perdés lo que ya pagaste</b>:
            seguís tomando turnos hasta el {servesUntil}, y tu agenda queda
            intacta. Después de esa fecha dejan de entrar turnos nuevos, pero
            vas a poder seguir viendo y cerrando los que tengas.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <form action={action}>
              <Button type="submit" variant="danger" size="sm" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                Confirmar baja
              </Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              No, volver
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
