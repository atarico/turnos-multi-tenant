import { describe, expect, it } from "vitest";

import {
  friendlyBookingError,
  friendlyOwnerBookingError,
  friendlyRescheduleError,
} from "./booking-errors";

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
    [
      "demasiadas reservas seguidas",
      "Hiciste varias reservas seguidas. Esperá un rato y volvé a intentar.",
    ],
    [
      "origen no identificado",
      "No pudimos procesar la reserva desde este origen. Probá de nuevo.",
    ],
  ])("translates the raw RPC error %o", (raw, expected) => {
    expect(friendlyBookingError(raw)).toBe(expected);
  });

  // El freno anti-spam no es un problema con la franja: mandar a "elegí otra"
  // sería un consejo inútil, así que su regla tiene que ganarle a las de cupo.
  it("prefers the throttle message over the slot rules", () => {
    expect(
      friendlyBookingError("demasiadas reservas seguidas; no quedan lugares"),
    ).toBe("Hiciste varias reservas seguidas. Esperá un rato y volvé a intentar.");
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

describe("friendlyRescheduleError", () => {
  // Mover un turno revalida lo MISMO que crearlo, así que comparte los
  // mensajes de cupo, solape y horario. Sólo cambia el desenlace.
  it.each([
    ["no quedan lugares", "No quedan lugares en esa franja. Elegí otra."],
    ["ya tiene un turno", "El profesional ya tiene un turno en ese horario."],
    ["no atiende", "El profesional no atiende en ese horario."],
    ["ya pasó", "Esa franja ya pasó. Elegí otra."],
  ])("shares the create_booking translation for %o", (raw, expected) => {
    expect(friendlyRescheduleError(raw)).toBe(expected);
  });

  it.each([
    ["turno inexistente", "No encontramos ese turno."],
    ["ya está cerrado", "Ese turno ya está cerrado: no se puede reprogramar."],
  ])("translates the reschedule-only error %o", (raw, expected) => {
    expect(friendlyRescheduleError(raw)).toBe(expected);
  });

  it("falls back to a reschedule-specific message, not the create one", () => {
    expect(friendlyRescheduleError("connection reset by peer")).toBe(
      "No pudimos reprogramar el turno. Intentá de nuevo.",
    );
  });
});

/**
 * El rechazo por plan vencido es el MISMO error de la base para los dos
 * caminos, y tiene que leerse distinto según quién esté del otro lado. Estos
 * casos existen para que nadie unifique los dos textos "porque es el mismo
 * error": lo es del lado de Postgres, no del lado de quien lo lee.
 */
describe("negocio sin plan activo", () => {
  it("al visitante le dice qué pasa, sin contarle por qué", () => {
    const message = friendlyBookingError("Negocio sin plan activo");

    expect(message).toBe(
      "Este negocio no está tomando reservas online por ahora. Escribile directo para coordinar.",
    );
  });

  /**
   * Lo que el negocio debe, cuánto y desde cuándo no es asunto del visitante.
   * La vista `public_tenants` se cuida de no exponer el plan ni el estado;
   * filtrarlo acá por un mensaje de error sería entregar por la puerta de
   * adelante lo mismo que la base protege.
   */
  it.each(["prueba", "plan", "venci", "pag", "suscrip"])(
    "el mensaje del visitante no menciona %s",
    (leak) => {
      expect(
        friendlyBookingError("Negocio sin plan activo").toLowerCase(),
      ).not.toContain(leak);
    },
  );

  it("al dueño le dice qué pasó y dónde se arregla", () => {
    const message = friendlyOwnerBookingError("Negocio sin plan activo");

    expect(message).toContain("no tiene un plan activo");
    expect(message).toContain("Suscripción");
  });

  /**
   * `tenant_takes_bookings()` rechaza por igual la prueba vencida, la
   * suscripción cancelada y la ausencia de suscripción, y los tres llegan con
   * el MISMO string. Nombrar la prueba sería mentirle a dos de los tres: a
   * quien canceló el mes pasado, "se te terminó la prueba gratis" le describe
   * algo que no pasó y lo manda a buscar una prueba que ya no existe.
   */
  it("el mensaje del dueño no nombra la prueba, que es sólo una de las tres causas", () => {
    expect(
      friendlyOwnerBookingError("Negocio sin plan activo").toLowerCase(),
    ).not.toContain("prueba");
  });

  /**
   * Lo primero que piensa un dueño al ver que no entran turnos es que perdió la
   * agenda. Decírselo en el mismo mensaje es la diferencia entre un susto y un
   * trámite.
   */
  it("al dueño le aclara que no perdió la agenda", () => {
    expect(friendlyOwnerBookingError("Negocio sin plan activo")).toContain(
      "agenda sigue intacta",
    );
  });

  it("los dos mensajes son distintos", () => {
    expect(friendlyOwnerBookingError("Negocio sin plan activo")).not.toBe(
      friendlyBookingError("Negocio sin plan activo"),
    );
  });

  /**
   * El panel comparte las reglas de la franja: el motor de turnos es el mismo y
   * un cupo lleno se lee igual venga por donde venga.
   */
  it("el dueño sigue leyendo las reglas de la franja", () => {
    expect(friendlyOwnerBookingError("no quedan lugares")).toBe(
      "No quedan lugares en esa franja. Elegí otra.",
    );
  });

  /**
   * El freno anti-spam lo tira `create_public_booking()`, que el panel no llama
   * nunca. Si apareciera acá sería un bug, y contestarle al dueño "hiciste
   * varias reservas seguidas" lo mandaría a esperar en vez de a mirar el error.
   */
  it("el dueño NO recibe los mensajes del camino anónimo", () => {
    expect(friendlyOwnerBookingError("demasiadas reservas seguidas")).toBe(
      "No pudimos crear la reserva. Revisá los datos e intentá de nuevo.",
    );
  });
});
