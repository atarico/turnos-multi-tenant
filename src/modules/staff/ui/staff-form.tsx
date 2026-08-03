"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { type ActionState, idleState } from "@/core/action";
import type { CatalogService } from "@/modules/catalog/domain/types";

import type { StaffMember } from "../domain/types";

interface StaffFormProps {
  /** Profesional a editar, o `null` para dar de alta uno nuevo. */
  member: StaffMember | null;
  /** Catálogo del negocio: de acá salen los checkboxes de asignación. */
  services: CatalogService[];
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  onCancel: () => void;
}

/**
 * Alta y edición de un profesional, incluida la asignación de servicios.
 *
 * Los dos van juntos a propósito: un profesional sin servicios no aparece en
 * la página pública, así que separarlos en dos pantallas sería regalar un
 * estado intermedio inútil.
 */
export function StaffForm({ member, services, save, onCancel }: StaffFormProps) {
  const [state, action, pending] = useActionState(save, idleState);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  const editing = member !== null;
  const assigned = new Set(member?.serviceIds ?? []);

  return (
    <Card className="p-6">
      <h2 className="font-display text-lg font-semibold tracking-tight">
        {editing ? "Editar profesional" : "Nuevo profesional"}
      </h2>

      <form action={action} className="mt-4 space-y-4">
        <input type="hidden" name="id" value={member?.id ?? ""} />

        {state.status === "error" && (
          <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {state.message}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              defaultValue={member?.name ?? ""}
              placeholder="Ana Gómez"
              autoComplete="off"
            />
            {fieldErrors?.name && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <Label htmlFor="role">Especialidad</Label>
            <Input
              id="role"
              name="role"
              defaultValue={member?.role ?? ""}
              placeholder="Peluquera"
              autoComplete="off"
            />
            {fieldErrors?.role && (
              <p className="mt-1 text-xs text-danger">{fieldErrors.role}</p>
            )}
          </div>
        </div>

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-muted">
            Servicios que presta
          </legend>
          {services.length === 0 ? (
            <p className="text-sm text-muted">
              Creá un servicio primero: sin servicios asignados nadie puede
              reservar con esta persona.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {services.map((service) => (
                <label
                  key={service.id}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2 text-sm text-foreground transition-colors hover:border-gold/40"
                >
                  <input
                    type="checkbox"
                    name="serviceIds"
                    value={service.id}
                    defaultChecked={assigned.has(service.id)}
                    className="size-4 accent-gold"
                  />
                  {service.name}
                </label>
              ))}
            </div>
          )}
          {fieldErrors?.serviceIds && (
            <p className="mt-1 text-xs text-danger">{fieldErrors.serviceIds}</p>
          )}
        </fieldset>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending
              ? "Guardando…"
              : editing
                ? "Guardar cambios"
                : "Agregar profesional"}
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
