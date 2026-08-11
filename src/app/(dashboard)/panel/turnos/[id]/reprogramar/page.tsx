import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  getBooking,
  listStaffForService,
} from "@/modules/booking/application/queries";
import { canReschedule } from "@/modules/booking/domain/booking-transitions";
import { isLinkedBooking } from "@/modules/booking/domain/types";
import { RescheduleFlow } from "@/modules/booking/ui/reschedule-flow";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

export const metadata: Metadata = { title: "Reprogramar turno" };

export default async function ReprogramarTurnoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const tenant = await getCurrentTenant();
  if (!tenant) redirect("/panel");

  // `getBooking` filtra por tenant: un id de otro negocio cae en not-found,
  // igual que uno inexistente. No se distingue a propósito.
  const bookingResult = await getBooking(tenant.id, id);
  if (!bookingResult.ok) notFound();
  const booking = bookingResult.value;

  // Un turno cerrado no se mueve. Se corta acá además de en la action: no tiene
  // sentido pintar un calendario para algo que el servidor va a rechazar.
  if (!canReschedule(booking.status)) redirect("/panel");

  // `canReschedule` sólo deja pasar 'pending'/'confirmed': el CHECK
  // `bookings_service_link_or_terminal`/`..._staff_link_or_terminal` ya
  // garantiza `serviceId`/`staffId` no nulos para esos estados, así que esto
  // es formalmente inalcanzable — pero es la angostura honesta que
  // TypeScript necesita para pasar `booking` como `LinkedBookingDetail`.
  if (!isLinkedBooking(booking)) notFound();

  const staffResult = await listStaffForService(tenant.id, booking.serviceId);
  const staffList = staffResult.ok ? staffResult.value : [];

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
          Reprogramar turno
        </h1>
        <p className="mt-1 text-sm text-muted">
          Elegí la franja nueva. El cliente y el servicio no cambian.
        </p>
      </header>

      <RescheduleFlow
        booking={booking}
        staffList={staffList}
        timezone={tenant.timezone}
      />
    </div>
  );
}
