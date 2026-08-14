import { describe, expect, it } from "vitest";

import {
  BOOKING_ACTION_LABELS,
  allowedTransitions,
  allowedTransitionsAt,
  canReschedule,
  canTransition,
  canTransitionAt,
  hasBookingEnded,
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

const LIVE: BookingStatus[] = ["pending", "confirmed"];

/** Un turno que termina a las 15:00, mirado un minuto antes y un minuto después. */
const ENDS_AT = "2026-08-20T15:00:00.000Z";
const END = Date.parse(ENDS_AT);
const BEFORE = END - 60_000;
const AFTER = END + 60_000;

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

describe("hasBookingEnded", () => {
  it("un turno que todavía no llegó a su fin no terminó", () => {
    expect(hasBookingEnded(ENDS_AT, BEFORE)).toBe(false);
  });

  it("terminó una vez pasado su fin", () => {
    expect(hasBookingEnded(ENDS_AT, AFTER)).toBe(true);
  });

  // El borde es cerrado: en el instante exacto del fin el turno YA terminó,
  // igual que `listBookingsToClose` lo considera vencido apenas pasa `ends_at`.
  it("terminó exactamente en el instante de su fin", () => {
    expect(hasBookingEnded(ENDS_AT, END)).toBe(true);
  });

  // Si no se puede leer el fin, se asume que NO terminó: falla del lado seguro,
  // que es el que no deja cerrar un turno futuro.
  it("trata un fin ilegible como turno todavía no terminado", () => {
    expect(hasBookingEnded("mañana a la tarde", AFTER)).toBe(false);
  });
});

describe("allowedTransitionsAt", () => {
  it("no ofrece cerrar un turno que todavía no terminó", () => {
    expect(allowedTransitionsAt("confirmed", ENDS_AT, BEFORE)).toEqual([
      "cancelled",
    ]);
    expect(allowedTransitionsAt("pending", ENDS_AT, BEFORE)).toEqual([
      "confirmed",
      "cancelled",
    ]);
  });

  it("ofrece los tres desenlaces una vez que el turno terminó", () => {
    expect(allowedTransitionsAt("confirmed", ENDS_AT, AFTER)).toEqual(
      allowedTransitions("confirmed"),
    );
    expect(allowedTransitionsAt("pending", ENDS_AT, AFTER)).toEqual(
      allowedTransitions("pending"),
    );
  });

  it("ya deja cerrar en el instante exacto del fin", () => {
    expect(allowedTransitionsAt("confirmed", ENDS_AT, END)).toContain(
      "completed",
    );
    expect(allowedTransitionsAt("confirmed", ENDS_AT, END)).toContain("no_show");
  });

  // Cancelar un turno futuro es el caso NORMAL: alguien avisa que no viene.
  it("deja cancelar un turno vivo en cualquier momento", () => {
    for (const status of LIVE) {
      for (const now of [BEFORE, END, AFTER]) {
        expect(allowedTransitionsAt(status, ENDS_AT, now)).toContain("cancelled");
      }
    }
  });

  it("no ofrece nada sobre un turno ya cerrado, haya terminado o no", () => {
    for (const status of TERMINAL) {
      expect(allowedTransitionsAt(status, ENDS_AT, BEFORE)).toEqual([]);
      expect(allowedTransitionsAt(status, ENDS_AT, AFTER)).toEqual([]);
    }
  });

  it("no ofrece cerrar si el fin del turno es ilegible", () => {
    expect(allowedTransitionsAt("confirmed", "", AFTER)).toEqual(["cancelled"]);
  });
});

describe("canTransitionAt", () => {
  it("no deja completar ni marcar ausente un turno que no terminó", () => {
    expect(canTransitionAt("confirmed", "completed", ENDS_AT, BEFORE)).toBe(false);
    expect(canTransitionAt("confirmed", "no_show", ENDS_AT, BEFORE)).toBe(false);
    expect(canTransitionAt("pending", "completed", ENDS_AT, BEFORE)).toBe(false);
  });

  it("deja cerrarlo una vez terminado", () => {
    expect(canTransitionAt("confirmed", "completed", ENDS_AT, AFTER)).toBe(true);
    expect(canTransitionAt("confirmed", "no_show", ENDS_AT, AFTER)).toBe(true);
  });

  it("no relaja las reglas que ya valían sin tiempo", () => {
    expect(canTransitionAt("cancelled", "completed", ENDS_AT, AFTER)).toBe(false);
    expect(canTransitionAt("confirmed", "pending", ENDS_AT, AFTER)).toBe(false);
  });

  it("deja confirmar y cancelar un turno futuro", () => {
    expect(canTransitionAt("pending", "confirmed", ENDS_AT, BEFORE)).toBe(true);
    expect(canTransitionAt("confirmed", "cancelled", ENDS_AT, BEFORE)).toBe(true);
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
