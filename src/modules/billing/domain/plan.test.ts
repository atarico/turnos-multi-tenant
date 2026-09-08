import { describe, expect, it } from "vitest";

import {
  bookingCeilingState,
  hasRoomForStaff,
  isOverStaffLimit,
  limitsFor,
  planLabel,
} from "./plan";

/**
 * Los límites del plan son de dos clases distintas y conviene no mezclarlas.
 *
 * Lo que se OCUPA (profesionales) es estado: se chequea al crear y, si el
 * negocio baja de plan estando por encima, no se le borra nada — simplemente
 * deja de poder agregar. Lo que se CONSUME (mensajes, turnos del mes) es un
 * contador que se resetea cada período; eso vive en otra tajada.
 *
 * Acá sólo se prueba la primera clase.
 */
describe("limitsFor", () => {
  it("básico llega a 2 profesionales y no incluye WhatsApp", () => {
    expect(limitsFor("basico")).toEqual({
      staff: 2,
      whatsappMessages: 0,
      bookingsPerMonth: 300,
    });
  });

  it("pro llega a 5 profesionales y estrena WhatsApp", () => {
    expect(limitsFor("pro")).toEqual({
      staff: 5,
      whatsappMessages: 800,
      bookingsPerMonth: 1500,
    });
  });

  it("premium llega a 15 profesionales", () => {
    expect(limitsFor("premium")).toEqual({
      staff: 15,
      whatsappMessages: 2000,
      bookingsPerMonth: 5000,
    });
  });

  /**
   * `PlanTier` es una unión de TypeScript y el valor real sale de una columna
   * de la base. Si alguien agrega un valor al enum de Postgres sin tocar el
   * catálogo, el lookup devolvía `undefined` y `hasRoomForStaff` reventaba con
   * un TypeError sobre `.staff` en vez de dar un error de dominio. Romper acá
   * es romper cerca del origen.
   */
  it("un plan que no está en el catálogo rompe, no devuelve undefined", () => {
    expect(() =>
      limitsFor("enterprise" as Parameters<typeof limitsFor>[0]),
    ).toThrow();
  });

  /**
   * Una clave HEREDADA de `Object.prototype` devolvía una FUNCIÓN, no
   * `undefined`: el guard la dejaba pasar y `hasRoomForStaff` leía `.staff`
   * sobre ella, respondiendo `false` en silencio en vez de romper.
   */
  it("una clave heredada del prototipo tampoco pasa", () => {
    expect(() =>
      limitsFor("toString" as Parameters<typeof limitsFor>[0]),
    ).toThrow();
  });

  /**
   * El orden importa para poder vender: si un plan más caro no diera MÁS de
   * cada cosa, no habría razón para subir. Se prueba la relación, no los
   * números, así el día que se muevan las cifras este test sigue teniendo
   * sentido.
   */
  it("cada plan da más que el anterior en todo", () => {
    const basico = limitsFor("basico");
    const pro = limitsFor("pro");
    const premium = limitsFor("premium");

    expect(pro.staff).toBeGreaterThan(basico.staff);
    expect(premium.staff).toBeGreaterThan(pro.staff);
    expect(pro.whatsappMessages).toBeGreaterThan(basico.whatsappMessages);
    expect(premium.whatsappMessages).toBeGreaterThan(pro.whatsappMessages);
    expect(pro.bookingsPerMonth).toBeGreaterThan(basico.bookingsPerMonth);
    expect(premium.bookingsPerMonth).toBeGreaterThan(pro.bookingsPerMonth);
  });
});

describe("hasRoomForStaff", () => {
  it("hay lugar mientras no se llegó al límite", () => {
    expect(hasRoomForStaff("basico", 0)).toBe(true);
    expect(hasRoomForStaff("basico", 1)).toBe(true);
  });

  // Justo en el límite YA no hay lugar: el que viene sería el número 3.
  it("no hay lugar al tocar el límite", () => {
    expect(hasRoomForStaff("basico", 2)).toBe(false);
  });

  /**
   * Pasa cuando el negocio baja de plan con más profesionales de los que el
   * plan nuevo permite. No es un estado inválido: es el estado normal de una
   * degradación, y tiene que responder que no hay lugar sin romperse.
   */
  it("tampoco hay lugar estando por encima del límite", () => {
    expect(hasRoomForStaff("basico", 7)).toBe(false);
  });
});

describe("isOverStaffLimit", () => {
  /**
   * Pregunta distinta de la anterior, aunque salgan del mismo número: "¿puedo
   * agregar uno más?" no es lo mismo que "¿ya me pasé?". Estar JUSTO en el
   * límite es no tener lugar, pero no es haberse pasado — y al negocio hay que
   * avisarle sólo en el segundo caso.
   */
  it("estar justo en el límite no es haberse pasado", () => {
    expect(isOverStaffLimit("basico", 2)).toBe(false);
  });

  it("se pasó cuando tiene más de los que el plan permite", () => {
    expect(isOverStaffLimit("basico", 3)).toBe(true);
  });

  it("con lugar de sobra no se pasó", () => {
    expect(isOverStaffLimit("premium", 4)).toBe(false);
  });
});

describe("planLabel", () => {
  /**
   * Esto no es texto de pantalla: viaja como `reason` a Mercado Pago y termina
   * en el resumen de la tarjeta del dueño. Que diga cuál plan es lo que evita
   * un desconocimiento de cargo meses después.
   */
  it("cada plan tiene un nombre para mostrarle a una persona", () => {
    expect(planLabel("basico")).toBe("Básico");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("premium")).toBe("Premium");
  });

  it("un plan que no está en el catálogo rompe, no devuelve undefined", () => {
    expect(() =>
      planLabel("enterprise" as Parameters<typeof planLabel>[0]),
    ).toThrow();
  });

  it("una clave heredada del prototipo tampoco pasa", () => {
    expect(() =>
      planLabel("toString" as Parameters<typeof planLabel>[0]),
    ).toThrow();
  });
});


/**
 * El techo de turnos del período.
 *
 * Se cuenta por CARGA (`created_at`), no por fecha del turno: el techo existe
 * para ver abuso, y contar por `starts_at` lo dejaría ciego justo ante el caso
 * más obvio —cargar cincuenta mil turnos con fecha del año que viene no
 * topearía ningún período nunca—. Contar por carga puede avisar de más; no
 * contar por carga no avisa nunca. Los dos errores no cuestan lo mismo.
 *
 * Por lo mismo, un turno cancelado CUENTA: ya ocupó una fila y ya consumió
 * sistema. Que después se cancele no devuelve lo gastado.
 */
describe("bookingCeilingState", () => {
  it("un período tranquilo no tiene nada que avisar", () => {
    expect(bookingCeilingState("basico", 0)).toBe("under");
    expect(bookingCeilingState("basico", 100)).toBe("under");
  });

  it("avisa al llegar al 80% del techo, no antes", () => {
    // Básico son 300. El 80% es 240.
    expect(bookingCeilingState("basico", 239)).toBe("under");
    expect(bookingCeilingState("basico", 240)).toBe("near");
  });

  it("tocar el techo ya es haberlo alcanzado, no estar cerca", () => {
    // Consumir el cupo entero es EL evento que hay que contar. Llamarlo
    // "casi" le diría al dueño que todavía le queda algo, y no le queda.
    expect(bookingCeilingState("basico", 299)).toBe("near");
    expect(bookingCeilingState("basico", 300)).toBe("over");
    expect(bookingCeilingState("basico", 5000)).toBe("over");
  });

  it("el techo es el del plan, no un número fijo", () => {
    // 300 turnos ahogan a Básico y son un martes cualquiera en Premium.
    expect(bookingCeilingState("basico", 300)).toBe("over");
    expect(bookingCeilingState("pro", 300)).toBe("under");
    expect(bookingCeilingState("premium", 300)).toBe("under");
  });

  it("un plan que no está en el catálogo rompe, no devuelve undefined", () => {
    expect(() =>
      bookingCeilingState("enterprise" as Parameters<typeof limitsFor>[0], 10),
    ).toThrow();
  });
});
