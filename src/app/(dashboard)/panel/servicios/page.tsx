import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  deleteServiceAction,
  saveServiceAction,
  toggleServiceActiveAction,
} from "@/modules/catalog/application/actions";
import { listCatalogServices } from "@/modules/catalog/application/queries";
import { ServicesManager } from "@/modules/catalog/ui/services-manager";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import { displayBookingUrl, publicBookingUrl } from "@/modules/tenants/domain/public-url";

export const metadata: Metadata = { title: "Servicios" };

export default async function ServicesPage() {
  const tenant = await getCurrentTenant();
  // Sin negocio no hay catálogo: el panel decide a dónde mandarlo.
  if (!tenant) redirect("/panel");

  const result = await listCatalogServices(tenant.id);
  const services = result.ok ? result.value : [];

  // Literal member access (not `serverEnv()`): panel pages don't otherwise
  // depend on the service-role env surface, and this keeps them free of it.
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL;
  if (!configuredOrigin) {
    console.warn(
      "NEXT_PUBLIC_APP_URL is not set; public booking links fall back to http://localhost:3000",
    );
  }
  const origin = configuredOrigin || "http://localhost:3000";
  const publicUrl = publicBookingUrl(origin, tenant.slug);

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
          Servicios
        </h1>
        <p className="mt-1 text-sm text-muted">
          Lo que ofrecés y cuánto dura cada cosa. Es lo que ve quien entra a
          reservar en{" "}
          <a
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-border-strong underline-offset-2 transition-colors hover:text-foreground"
          >
            {displayBookingUrl(publicUrl)}
          </a>
          .
        </p>
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
