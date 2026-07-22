"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { idleState } from "@/core/action";

import { formatPrice } from "../domain/money";
import type { CatalogService } from "../domain/types";
import type { ServiceActions } from "./service-actions";

interface ServiceListProps {
  services: CatalogService[];
  /** El padre pasa el servicio al formulario para editarlo. */
  onEdit: (service: CatalogService) => void;
  actions: ServiceActions;
}

/**
 * Catálogo de servicios del negocio. Muestra activos e inactivos: pausar un
 * servicio lo saca de la página pública sin perder su historial de turnos,
 * que es lo que casi siempre se quiere en vez de eliminarlo.
 */
export function ServiceList({ services, onEdit, actions }: ServiceListProps) {
  if (services.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted">
          Todavía no cargaste servicios. Creá el primero para que puedan
          reservarte.
        </p>
      </Card>
    );
  }

  return (
    <ul className="space-y-2">
      {services.map((service) => (
        <li key={service.id}>
          <ServiceRow service={service} onEdit={onEdit} actions={actions} />
        </li>
      ))}
    </ul>
  );
}

function ServiceRow({
  service,
  onEdit,
  actions,
}: {
  service: CatalogService;
  onEdit: (service: CatalogService) => void;
  actions: ServiceActions;
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
            <p className="truncate font-medium text-foreground">{service.name}</p>
            <Badge variant={service.active ? "success" : "muted"}>
              {service.active ? "Activo" : "Pausado"}
            </Badge>
          </div>
          {service.description && (
            <p className="mt-1 truncate text-sm text-muted">
              {service.description}
            </p>
          )}
          <p className="mt-1 text-sm text-muted">
            {service.durationMin} min · {formatPrice(service.priceCents, service.currency)} ·
            cupo {service.capacity}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onEdit(service)}
          >
            Editar
          </Button>

          <form action={toggle}>
            <input type="hidden" name="id" value={service.id} />
            <input type="hidden" name="active" value={String(!service.active)} />
            <Button type="submit" variant="ghost" size="sm" disabled={toggling}>
              {service.active ? "Pausar" : "Activar"}
            </Button>
          </form>

          <form action={remove}>
            <input type="hidden" name="id" value={service.id} />
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
