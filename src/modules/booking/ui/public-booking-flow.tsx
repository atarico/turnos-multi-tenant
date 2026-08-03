"use client";

import {
  createPublicBookingAction,
  getPublicAvailabilityAction,
  getPublicSlotsAction,
  listPublicStaffAction,
} from "../application/public-actions";
import type { BookableService } from "../domain/types";
import { BookingFlow, type BookingActions } from "./booking-flow";

interface PublicBookingFlowProps {
  slug: string;
  services: BookableService[];
  timezone: string;
}

/**
 * Boundary de cliente de la página pública: arma el adapter `BookingActions`
 * cerrando sobre el `slug` de la ruta y se lo inyecta a `BookingFlow`, que así
 * queda igual de agnóstico que en el panel. Vive del lado del cliente a
 * propósito — un closure inline creado en un Server Component no es una Server
 * Action registrada y no cruza el borde RSC; acá, en cambio, las Server Actions
 * públicas se invocan desde el cliente con el slug ya atado.
 */
export function PublicBookingFlow({
  slug,
  services,
  timezone,
}: PublicBookingFlowProps) {
  const actions: BookingActions = {
    listStaff: (serviceId) => listPublicStaffAction(slug, serviceId),
    getAvailability: (staffId) => getPublicAvailabilityAction(slug, staffId),
    getSlots: (serviceId, staffId, dateStr) =>
      getPublicSlotsAction(slug, serviceId, staffId, dateStr),
    createBooking: (input) => createPublicBookingAction(slug, input),
  };

  return (
    <BookingFlow services={services} timezone={timezone} actions={actions} />
  );
}
