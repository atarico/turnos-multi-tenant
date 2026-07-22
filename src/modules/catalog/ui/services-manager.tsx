"use client";

import { useState } from "react";

import type { CatalogService } from "../domain/types";
import type { ServiceActions } from "./service-actions";
import { ServiceForm } from "./service-form";
import { ServiceList } from "./service-list";

interface ServicesManagerProps {
  services: CatalogService[];
  actions: ServiceActions;
}

/**
 * Une el formulario y la lista del catálogo. Es el único componente con estado
 * de la pantalla: qué servicio se está editando. Todo lo demás es
 * presentacional y recibe lo que necesita por props.
 *
 * El `key` en el formulario no es decorativo: al cambiar de servicio remonta el
 * componente, y eso resetea tanto los `defaultValue` de los inputs como el
 * estado de `useActionState` (que si no arrastraría el error del servicio anterior).
 */
export function ServicesManager({ services, actions }: ServicesManagerProps) {
  const [editing, setEditing] = useState<CatalogService | null>(null);

  return (
    <div className="space-y-6">
      <ServiceForm
        key={editing?.id ?? "new"}
        service={editing}
        save={actions.save}
        onCancel={() => setEditing(null)}
      />
      <ServiceList services={services} onEdit={setEditing} actions={actions} />
    </div>
  );
}
