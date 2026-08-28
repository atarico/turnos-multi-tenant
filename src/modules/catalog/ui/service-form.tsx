"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { type ActionState, idleState } from "@/core/action";

import { formatPriceInput } from "../domain/money";
import type { CatalogService } from "../domain/types";

interface ServiceFormProps {
  /** Servicio a editar, o `null` para dar de alta uno nuevo. */
  service: CatalogService | null;
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  onCancel: () => void;
}

/**
 * Formulario de alta y edición de un servicio.
 *
 * Es el MISMO formulario para los dos casos: cambia el `id` que viaja oculto y
 * el texto del botón. La action recibida por prop decide qué hacer con ese id,
 * así este componente no sabe nada de Supabase.
 */
export function ServiceForm({ service, save, onCancel }: ServiceFormProps) {
  const [state, action, pending] = useActionState(save, idleState);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  const editing = service !== null;

  return (
    <Card className="p-6">
      <h2 className="font-display text-lg font-semibold tracking-tight">
        {editing ? "Editar servicio" : "Nuevo servicio"}
      </h2>

      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="id" value={service?.id ?? ""} />

        {state.status === "error" && (
          <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {state.message}
          </p>
        )}

        {/* Guardar un servicio deja al negocio a mitad de camino: hasta que no
            haya un profesional que lo preste, la página pública no ofrece un
            solo turno. Por eso el próximo paso se ofrece acá y no en el panel. */}
        {state.status === "success" && (
          <div className="rounded-xl border border-gold/30 bg-gold/10 px-3.5 py-3">
            <p className="text-sm text-foreground">{state.message}</p>
            <p className="mt-1 text-sm text-muted">
              Ahora sumá a quién lo presta: sin profesionales, nadie puede
              reservarlo.
            </p>
            <Link
              href="/panel/profesionales"
              className={buttonClasses({
                variant: "outline",
                size: "sm",
                className: "mt-3",
              })}
            >
              <Users className="size-4" />
              Agregar un profesional
            </Link>
          </div>
        )}

        <div>
          <Label htmlFor="name">Nombre</Label>
          <Input
            id="name"
            name="name"
            defaultValue={service?.name ?? ""}
            placeholder="Corte de pelo"
          />
          {fieldErrors?.name && (
            <p className="mt-1 text-xs text-danger">{fieldErrors.name}</p>
          )}
        </div>

        <div>
          <Label htmlFor="description">Descripción</Label>
          <Input
            id="description"
            name="description"
            defaultValue={service?.description ?? ""}
            placeholder="Lavado, corte y peinado"
          />
          {fieldErrors?.description && (
            <p className="mt-1 text-xs text-danger">{fieldErrors.description}</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="durationMin">Duración (minutos)</Label>
            <Input
              id="durationMin"
              name="durationMin"
              inputMode="numeric"
              defaultValue={service ? String(service.durationMin) : ""}
              placeholder="45"
            />
            {fieldErrors?.durationMin && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.durationMin}</p>
            )}
          </div>

          <div>
            <Label htmlFor="price">Precio</Label>
            <Input
              id="price"
              name="price"
              inputMode="decimal"
              defaultValue={service ? formatPriceInput(service.priceCents) : ""}
              placeholder="1.500,50"
            />
            {fieldErrors?.price && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.price}</p>
            )}
          </div>

          <div>
            <Label htmlFor="capacity">Cupo por turno</Label>
            <Input
              id="capacity"
              name="capacity"
              inputMode="numeric"
              defaultValue={service ? String(service.capacity) : "1"}
            />
            {fieldErrors?.capacity && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.capacity}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending
              ? "Guardando…"
              : editing
                ? "Guardar cambios"
                : "Crear servicio"}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
