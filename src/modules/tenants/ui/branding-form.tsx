"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { type ActionState, idleState } from "@/core/action";

import { readableTextOn } from "../domain/brand";

interface BrandingFormProps {
  /** Color guardado hoy, tal como viene de la base. */
  brandColor: string;
  /** La Server Action llega inyectada: así el form se testea con un espía. */
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

/**
 * Elección del color de marca del negocio, con vista previa de cómo se ve en la
 * página pública.
 *
 * El input es CONTROLADO, no controlado por el DOM. React 19 dispara
 * `requestFormReset` al resolver una action, y un input sin `value` vuelve a su
 * `defaultValue`: el dueño elegía un color, guardaba, y la pantalla le mostraba
 * el anterior. Mismo bug que ya apareció en el editor de horarios.
 */
export function BrandingForm({ brandColor, save }: BrandingFormProps) {
  const [state, action, pending] = useActionState(save, idleState);
  const [color, setColor] = useState(brandColor);

  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  /**
   * El cartel de éxito se DERIVA, no se guarda en estado.
   *
   * La condición no es "el último submit salió bien" sino "salió bien Y lo que
   * hay en pantalla es lo que tiene el servidor". `brandColor` llega del server
   * component, que se vuelve a renderizar tras el `revalidatePath` de la
   * action: si el usuario toca el color después de guardar, deja de coincidir y
   * el cartel se baja solo.
   *
   * Sin esto el cartel se queda pegado para siempre y termina mintiendo — dice
   * "guardado" mientras en pantalla hay un color que nadie guardó. Es el mismo
   * defecto que quedó anotado en el editor de horarios.
   */
  const showSuccess = state.status === "success" && color === brandColor;
  const onBrand = readableTextOn(color);

  return (
    <form action={action} className="space-y-5">
      {state.status === "error" && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}

      {showSuccess && state.message && (
        <p className="rounded-xl border border-success/30 bg-success/10 px-3.5 py-2.5 text-sm text-success">
          {state.message}
        </p>
      )}

      <div>
        <Label htmlFor="brandColor">Color de marca</Label>
        <div className="mt-1 flex items-center gap-3">
          <input
            id="brandColor"
            name="brandColor"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-11 w-16 shrink-0 cursor-pointer rounded-xl border border-border bg-surface-2 p-1"
          />
          <code className="text-sm uppercase tracking-wide text-muted">
            {color}
          </code>
        </div>
        {fieldErrors?.brandColor && (
          <p className="mt-1 text-xs text-danger">{fieldErrors.brandColor}</p>
        )}
      </div>

      <div>
        <p className="text-xs uppercase tracking-widest text-muted">
          Así se ve en tu página
        </p>
        {/*
          Usa el color del estado local, no el guardado: la gracia es ver el
          cambio ANTES de apretar guardar. Y calcula el texto con la misma
          función que la página pública (`readableTextOn`), así que la vista
          previa no puede mentir sobre el contraste real.
        */}
        <div className="mt-2 flex items-center gap-4 rounded-2xl border border-border bg-surface-2 p-4">
          <span
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl font-display text-lg font-semibold"
            style={{ backgroundColor: color, color: onBrand }}
          >
            A
          </span>
          <div className="min-w-0">
            <p
              className="inline-block rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-widest"
              style={{ backgroundColor: color, color: onBrand }}
            >
              Reservá tu turno
            </p>
            <p className="truncate font-display text-lg font-semibold tracking-tight">
              Tu negocio
            </p>
          </div>
        </div>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar color"}
      </Button>
    </form>
  );
}
