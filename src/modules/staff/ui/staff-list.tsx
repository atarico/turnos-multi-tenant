"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { idleState } from "@/core/action";
import type { CatalogService } from "@/modules/catalog/domain/types";

import type { StaffMember } from "../domain/types";
import type { StaffActions } from "./staff-actions";

interface StaffListProps {
  members: StaffMember[];
  /** Catálogo completo: se usa para nombrar los servicios de cada fila. */
  services: CatalogService[];
  onEdit: (member: StaffMember) => void;
  actions: StaffActions;
}

/**
 * Profesionales del negocio. Muestra activos y pausados: pausar saca a la
 * persona de la página pública sin perder los turnos que ya atendió.
 */
export function StaffList({ members, services, onEdit, actions }: StaffListProps) {
  if (members.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted">
          Todavía no cargaste profesionales. Agregá al menos uno para que
          puedan reservar con él.
        </p>
      </Card>
    );
  }

  const nameById = new Map(services.map((s) => [s.id, s.name]));

  return (
    <ul className="space-y-2">
      {members.map((member) => (
        <li key={member.id}>
          <StaffRow
            member={member}
            serviceNames={member.serviceIds
              .map((id) => nameById.get(id))
              .filter((name): name is string => name !== undefined)}
            onEdit={onEdit}
            actions={actions}
          />
        </li>
      ))}
    </ul>
  );
}

function StaffRow({
  member,
  serviceNames,
  onEdit,
  actions,
}: {
  member: StaffMember;
  serviceNames: string[];
  onEdit: (member: StaffMember) => void;
  actions: StaffActions;
}) {
  const [toggleState, toggle, toggling] = useActionState(
    actions.toggleActive,
    idleState,
  );
  const [removeState, remove, removing] = useActionState(
    actions.remove,
    idleState,
  );

  // Una fila hace una cosa por vez: alcanza con mostrar el error que haya.
  const error =
    toggleState.status === "error"
      ? toggleState.message
      : removeState.status === "error"
        ? removeState.message
        : null;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium text-foreground">{member.name}</p>
            <Badge variant={member.active ? "success" : "muted"}>
              {member.active ? "Activo" : "Pausado"}
            </Badge>
          </div>
          {member.role && (
            <p className="mt-1 truncate text-sm text-muted">{member.role}</p>
          )}
          {serviceNames.length > 0 ? (
            <p className="mt-1 truncate text-sm text-muted">
              {serviceNames.join(" · ")}
            </p>
          ) : (
            // No es un detalle estético: sin servicios no aparece en la página
            // pública, y desde afuera parece que el negocio no atiende.
            <p className="mt-1 text-sm text-gold">
              Sin servicios asignados: nadie puede reservar con esta persona.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onEdit(member)}
          >
            Editar
          </Button>

          <form action={toggle}>
            <input type="hidden" name="id" value={member.id} />
            <input type="hidden" name="active" value={String(!member.active)} />
            <Button type="submit" variant="ghost" size="sm" disabled={toggling}>
              {member.active ? "Pausar" : "Activar"}
            </Button>
          </form>

          <form action={remove}>
            <input type="hidden" name="id" value={member.id} />
            <Button type="submit" variant="danger" size="sm" disabled={removing}>
              Eliminar
            </Button>
          </form>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
    </Card>
  );
}
