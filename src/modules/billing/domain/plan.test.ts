import { describe, expect, it } from "vitest";

import { hasRoomForStaff, isOverStaffLimit, limitsFor } from "./plan";

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
