import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { updateBrandingAction } from "@/modules/tenants/application/actions";
import {
  removeLogoAction,
  uploadLogoAction,
} from "@/modules/tenants/application/logo-actions";
import { resolvePublicBookingUrl } from "@/modules/tenants/application/public-url";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import { BrandingForm } from "@/modules/tenants/ui/branding-form";
import { LogoForm } from "@/modules/tenants/ui/logo-form";
import { PublicLinkField } from "@/modules/tenants/ui/public-link-field";

export const metadata: Metadata = { title: "Configuración" };

/**
 * Configuración del negocio. Hoy sólo el color de marca; nace como ruta propia
 * y no como sección del panel porque es el lugar natural para lo que venga
 * después (logo, datos del negocio, zona horaria) y mudarlo más tarde costaría
 * más que abrirlo ahora.
 */
export default async function SettingsPage() {
  const tenant = await getCurrentTenant();
  // Sin negocio no hay nada que configurar: el panel decide a dónde mandarlo.
  if (!tenant) redirect("/panel");

  const publicUrl = resolvePublicBookingUrl(tenant.slug);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <Link
          href="/panel"
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          <ArrowLeft className="size-4" />
          Volver al panel general
        </Link>
        <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">
          Configuración
        </h1>
        <p className="mt-1 text-sm text-muted">
          Cómo se ve tu negocio para quien entra a reservar.
        </p>
        <PublicLinkField url={publicUrl} className="mt-3 max-w-md" />
      </header>

      {/*
        `Tenant` sale del join tal cual viene de la base, así que sus campos
        están en snake_case — a diferencia de `PublicTenant`, que sí pasa por
        `toPublicTenant`. La UI habla camelCase; la traducción se hace acá.
      */}
      <section className="mt-8">
        <BrandingForm
          brandColor={tenant.brand_color}
          save={updateBrandingAction}
        />
      </section>

      <section className="mt-10 border-t border-border pt-8">
        <LogoForm
          logoUrl={tenant.logo_url}
          upload={uploadLogoAction}
          remove={removeLogoAction}
        />
      </section>
    </div>
  );
}
