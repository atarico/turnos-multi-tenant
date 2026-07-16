import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { listServices } from "@/modules/booking/application/queries";
import { BookingFlow } from "@/modules/booking/ui/booking-flow";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

export const metadata: Metadata = { title: "Nueva reserva" };

export default async function NuevaReservaPage() {
  const tenant = await getCurrentTenant();

  // Sin negocio no hay agenda que cargar: de vuelta al onboarding del panel.
  if (!tenant) redirect("/panel");

  const servicesResult = await listServices(tenant.id);
  const services = servicesResult.ok ? servicesResult.value : [];

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <Link
        href="/panel"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Volver al panel
      </Link>

      <header className="mt-4 mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Nueva reserva
        </h1>
        <p className="mt-1 text-sm text-muted">
          Cargá un turno manualmente para {tenant.name}.
        </p>
      </header>

      {!servicesResult.ok ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {servicesResult.error.message}
        </p>
      ) : (
        <BookingFlow services={services} timezone={tenant.timezone} />
      )}
    </div>
  );
}
