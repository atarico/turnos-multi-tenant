import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import {
  deleteServiceAction,
  saveServiceAction,
  toggleServiceActiveAction,
} from "@/modules/catalog/application/actions";
import { listCatalogServices } from "@/modules/catalog/application/queries";
import { ServicesManager } from "@/modules/catalog/ui/services-manager";
import { resolvePublicBookingUrl } from "@/modules/tenants/application/public-url";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import { PublicLinkField } from "@/modules/tenants/ui/public-link-field";

export const metadata: Metadata = { title: "Servicios" };

export default async function ServicesPage() {
  const tenant = await getCurrentTenant();
  // Sin negocio no hay catálogo: el panel decide a dónde mandarlo.
  if (!tenant) redirect("/panel");

  const result = await listCatalogServices(tenant.id);
  const services = result.ok ? result.value : [];

  const publicUrl = resolvePublicBookingUrl(tenant.slug);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/panel"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            <ArrowLeft className="size-4" />
            Volver al panel general
          </Link>
          <Link
            href="/panel/profesionales"
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            <Users className="size-4" />
            Profesionales
          </Link>
        </div>
        <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">
          Servicios
        </h1>
        <p className="mt-1 text-sm text-muted">
          Lo que ofrecés y cuánto dura cada cosa. Es lo que ve quien entra a
          reservar en tu página pública.
        </p>
        <PublicLinkField url={publicUrl} className="mt-3 max-w-md" />
      </header>

      {!result.ok && (
        <p className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {result.error.message}
        </p>
      )}

      <div className="mt-8">
        <ServicesManager
          services={services}
          actions={{
            save: saveServiceAction,
            toggleActive: toggleServiceActiveAction,
            remove: deleteServiceAction,
          }}
        />
      </div>
    </div>
  );
}
