import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { listPublicServices } from "@/modules/booking/application/public-queries";
import { PublicBookingFlow } from "@/modules/booking/ui/public-booking-flow";
import { PublicHeader } from "@/modules/booking/ui/public-header";
import { getTenantBySlug } from "@/modules/tenants/application/queries";

interface PublicBookingPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PublicBookingPageProps): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return {};

  return {
    title: `Reservar en ${tenant.name}`,
    description: `Pedí tu turno en ${tenant.name} online.`,
  };
}

/**
 * El negocio existe pero no está tomando reservas online.
 *
 * NO es un 404 y no es un error: el negocio está ahí, su marca se sigue viendo
 * arriba, y quien llegó por su link tiene que poder seguir contactándolo. Lo
 * único que no está disponible es auto-reservar.
 *
 * Tampoco dice por qué. Que al negocio se le haya vencido la prueba, que deba
 * o que haya cancelado es información suya, no de quien vino a sacar un turno
 * — la vista `public_tenants` expone un booleano justamente para no filtrarlo.
 */
function ClosedForBookings({ name }: { name: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 px-5 py-6 text-center">
      <p className="text-sm font-medium text-foreground">
        {name} no está tomando reservas online por ahora.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Si tenías un turno con ellos, sigue en pie. Para sacar uno nuevo,
        escribiles o llamalos directo.
      </p>
    </div>
  );
}

/**
 * Página pública anónima `/{slug}`. El slug identifica el negocio (no hay
 * sesión): si no resuelve, 404. Los datos y la creación de la reserva viajan
 * por las Server Actions públicas, que revalidan todo del lado del servidor.
 */
export default async function PublicBookingPage({
  params,
}: PublicBookingPageProps) {
  const { slug } = await params;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const servicesResult = await listPublicServices(tenant.id);
  const services = servicesResult.ok ? servicesResult.value : [];

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <PublicHeader
        name={tenant.name}
        logoUrl={tenant.logoUrl}
        brandColor={tenant.brandColor}
      />

      <div className="mt-8">
        {!tenant.takesBookings ? (
          <ClosedForBookings name={tenant.name} />
        ) : !servicesResult.ok ? (
          <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {servicesResult.error.message}
          </p>
        ) : (
          <PublicBookingFlow
            slug={tenant.slug}
            services={services}
            timezone={tenant.timezone}
          />
        )}
      </div>
    </div>
  );
}
