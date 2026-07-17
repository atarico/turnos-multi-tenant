import { describe, expect, it } from "vitest";

import { friendlyBookingError } from "./booking-errors";

describe("friendlyBookingError", () => {
  it.each([
    ["no quedan lugares", "No quedan lugares en esa franja. Elegí otra."],
    ["ya tiene un turno", "El profesional ya tiene un turno en ese horario."],
    ["no atiende", "El profesional no atiende en ese horario."],
    ["ya pasó", "Esa franja ya pasó. Elegí otra."],
    ["no ofrece", "Ese profesional no ofrece este servicio."],
    ["profesional no disponible", "El profesional no está disponible."],
    ["servicio no disponible", "El servicio no está disponible."],
    ["negocio inexistente", "No encontramos ese negocio."],
  ])("translates the raw RPC error %o", (raw, expected) => {
    expect(friendlyBookingError(raw)).toBe(expected);
  });

  it("matches the raw error regardless of case", () => {
    expect(friendlyBookingError("ERROR: No Quedan Lugares en la franja")).toBe(
      "No quedan lugares en esa franja. Elegí otra.",
    );
  });

  it("matches when the raw error is wrapped in Postgres noise", () => {
    expect(
      friendlyBookingError('new row violates ... "el profesional no atiende" ... CONTEXT: PL/pgSQL'),
    ).toBe("El profesional no atiende en ese horario.");
  });

  it("falls back to a generic message for an unrecognised error", () => {
    expect(friendlyBookingError("connection reset by peer")).toBe(
      "No pudimos crear la reserva. Revisá los datos e intentá de nuevo.",
    );
  });

  // "profesional no disponible" contiene "no disponible", y "servicio no
  // disponible" también: el orden de los checks decide. Fijamos el actual para
  // que reordenarlos no cambie el mensaje en silencio.
  it("prefers the staff message when both staff and service wording appear", () => {
    expect(friendlyBookingError("profesional no disponible; servicio no disponible")).toBe(
      "El profesional no está disponible.",
    );
  });
});
