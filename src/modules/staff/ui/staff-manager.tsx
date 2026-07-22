"use client";

import { useState } from "react";

import type { CatalogService } from "@/modules/catalog/domain/types";

import type { StaffMember } from "../domain/types";
import type { StaffActions } from "./staff-actions";
import { StaffForm } from "./staff-form";
import { StaffList } from "./staff-list";

interface StaffManagerProps {
  members: StaffMember[];
  services: CatalogService[];
  actions: StaffActions;
}

/**
 * Une el formulario y la lista de profesionales. Único componente con estado de
 * la pantalla: qué profesional se está editando.
 *
 * El `key` en el formulario remonta el componente al cambiar de profesional, y
 * eso resetea los `defaultValue`/`defaultChecked` de los inputs y el estado de
 * `useActionState` (que si no arrastraría el error del anterior).
 */
export function StaffManager({ members, services, actions }: StaffManagerProps) {
  const [editing, setEditing] = useState<StaffMember | null>(null);

  return (
    <div className="space-y-6">
      <StaffForm
        key={editing?.id ?? "new"}
        member={editing}
        services={services}
        save={actions.save}
        onCancel={() => setEditing(null)}
      />
      <StaffList
        members={members}
        services={services}
        onEdit={setEditing}
        actions={actions}
      />
    </div>
  );
}
