import { describe, expect, it } from "vitest";

import {
  BOOKING_ACTION_LABELS,
  allowedTransitions,
  canReschedule,
  canTransition,
  isBookingStatus,
  isLiveBooking,
} from "./booking-transitions";
import type { BookingStatus } from "./types";

const TERMINAL: BookingStatus[] = ["cancelled", "completed", "no_show"];
const ALL: BookingStatus[] = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
];

describe("canTransition", () => {
  it("deja confirmar un turno pendiente", () => {
    expect(canTransition("pending", "confirmed")).toBe(true);
  });

  it("deja cerrar un turno vivo en cualquiera de los tres desenlaces", () => {
    for (const from of ["pending", "confirmed"] as BookingStatus[]) {
      for (const to of TERMINAL) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("no deja volver a 'pending': confirmar no se deshace", () => {
    expect(canTransition("confirmed", "pending")).toBe(false);
  });

  it("no deja mover un turno ya cerrado", () => {
    for (const from of TERMINAL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("no deja transicionar al mismo estado", () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("rechaza un estado desconocido de la base sin romper", () => {
    expect(canTransition("rescheduled" as BookingStatus, "cancelled")).toBe(false);
    expect(canTransition("confirmed", "rescheduled" as BookingStatus)).toBe(false);
  });
});

describe("allowedTransitions", () => {
  it("lista los destinos de un turno pendiente", () => {
    expect(allowedTransitions("pending")).toEqual([
      "confirmed",
      "completed",
      "no_show",
      "cancelled",
    ]);
  });

  it("lista los destinos de un turno confirmado", () => {
    expect(allowedTransitions("confirmed")).toEqual([
      "completed",
      "no_show",
      "cancelled",
    ]);
  });

  it("devuelve vacío para un turno cerrado", () => {
    for (const status of TERMINAL) {
      expect(allowedTransitions(status)).toEqual([]);
    }
  });

  it("devuelve vacío para un estado desconocido", () => {
    expect(allowedTransitions("rescheduled" as BookingStatus)).toEqual([]);
  });
});

describe("isLiveBooking", () => {
  it("sólo 'pending' y 'confirmed' ocupan la agenda", () => {
    expect(isLiveBooking("pending")).toBe(true);
    expect(isLiveBooking("confirmed")).toBe(true);
    for (const status of TERMINAL) {
      expect(isLiveBooking(status)).toBe(false);
    }
  });
});

describe("canReschedule", () => {
  it("deja mover un turno vivo", () => {
    expect(canReschedule("pending")).toBe(true);
    expect(canReschedule("confirmed")).toBe(true);
  });

  it("no deja mover un turno ya cerrado", () => {
    for (const status of TERMINAL) {
      expect(canReschedule(status)).toBe(false);
    }
  });
});

describe("isBookingStatus", () => {
  it("acepta los cinco estados del enum de la base", () => {
    for (const status of ALL) {
      expect(isBookingStatus(status)).toBe(true);
    }
  });

  // El estado llega como string suelto desde un FormData, o sea desde el
  // cliente: sin este guard, un POST armado a mano escribe cualquier cosa.
  it("rechaza cualquier string que no sea un estado conocido", () => {
    for (const value of ["", "rescheduled", "PENDING", "confirmed ", "drop"]) {
      expect(isBookingStatus(value)).toBe(false);
    }
  });
});

describe("BOOKING_ACTION_LABELS", () => {
  it("tiene una etiqueta de acción para cada destino alcanzable", () => {
    const reachable = new Set(
      ALL.flatMap((status) => allowedTransitions(status)),
    );
    for (const status of reachable) {
      expect(BOOKING_ACTION_LABELS[status]).toBeTruthy();
    }
  });
});
