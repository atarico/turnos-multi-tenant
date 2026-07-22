import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { listCatalogServices } from "@/modules/catalog/application/queries";
import {
  deleteStaffAction,
  saveStaffAction,
  toggleStaffActiveAction,
} from "@/modules/staff/application/actions";
import { listStaffMembers } from "@/modules/staff/application/queries";
import { StaffManager } from "@/modules/staff/ui/staff-manager";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

export const metadata: Metadata = { title: "Profesionales" };

export default async function StaffPage() {
  const tenant = await getCurrentTenant();
  // Sin negocio no hay equipo: el panel se encarga del onboarding.
  if (!tenant) redirect("/panel");

  // Las dos consultas son independientes: van en paralelo.
  const [staffResult, servicesResult] = await Promise.all([
    listStaffMembers(tenant.id),
    listCatalogServices(tenant.id),
  ]);

  const members = staffResult.ok ? staffResult.value : [];
  const services = servicesResult.ok ? servicesResult.value : [];
  const error = !staffResult.ok
    ? staffResult.error.message
    : !servicesResult.ok
      ? servicesResult.error.message
      : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header>
        <Link
          href="/panel"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Panel
        </Link>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">
          Profesionales
        </h1>
        <p className="mt-1 text-sm text-muted">
          Quién atiende y qué presta cada uno. Sin al menos un profesional con
          servicios asignados, tu página pública no tiene nada para ofrecer.
        </p>
      </header>

      {error && (
        <p className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-8">
        <StaffManager
          members={members}
          services={services}
          actions={{
            save: saveStaffAction,
            toggleActive: toggleStaffActiveAction,
            remove: deleteStaffAction,
          }}
        />
      </div>
    </div>
  );
}
