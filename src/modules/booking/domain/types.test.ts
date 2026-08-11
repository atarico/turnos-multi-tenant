import { describe, expect, it } from "vitest";

import { isLinkedBooking } from "./types";
import type { BookingDetail } from "./types";

/**
 * `isLinkedBooking` traduce a algo que el compilador entiende la garantía que
 * ya da el CHECK `bookings_service_link_or_terminal` / `..._staff_link_or_terminal`:
 * un turno 'pending'/'confirmed'/'completed' SIEMPRE tiene `serviceId`/`staffId`
 * no nulos. Angostar sólo las propiedades sueltas no alcanza para pasar el
 * objeto entero como `LinkedBookingDetail` — de ahí el type guard.
 */

const base: BookingDetail = {
  id: "b1",
  customerName: "Ana",
  customerPhone: null,
  serviceName: "Corte",
  staffName: "Juan",
  startsAt: "2026-09-01T10:00:00Z",
  endsAt: "2026-09-01T10:30:00Z",
  status: "confirmed",
  serviceId: "service-1",
  staffId: "staff-1",
};

describe("isLinkedBooking", () => {
  it("is true when both references are linked", () => {
    expect(isLinkedBooking(base)).toBe(true);
  });

  it("is false when the service was unlinked", () => {
    expect(isLinkedBooking({ ...base, serviceId: null })).toBe(false);
  });

  it("is false when the staff member was unlinked", () => {
    expect(isLinkedBooking({ ...base, staffId: null })).toBe(false);
  });

  it("is false when both references were unlinked", () => {
    expect(isLinkedBooking({ ...base, serviceId: null, staffId: null })).toBe(
      false,
    );
  });
});
