import { describe, expect, it } from "vitest";

import { isInTrial, trialDaysLeft } from "./subscription";

/**
 * La prueba gratis se maneja con una fecha en la suscripción, sin tarjeta y
 * sin tocar la pasarela. Pedir tarjeta de entrada mata la conversión en este
 * segmento, y meter el trial dentro del cobro recurrente complica la
 * integración para nada.
 *
 * Todo acá recibe el `now` como parámetro. Leer el reloj adentro haría que
 * estos tests fallaran solos algún martes a la medianoche.
 */

const NOW = new Date("2026-08-17T12:00:00Z");

/** Una suscripción en prueba que vence dentro de `days` días. */
function trialEndingIn(days: number) {
  const trialEndsAt = new Date(NOW);
  trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + days);
  return { status: "trialing" as const, trialEndsAt };
}

describe("isInTrial", () => {
  it("está en prueba mientras el estado es trialing y no venció", () => {
    expect(isInTrial(trialEndingIn(5), NOW)).toBe(true);
  });

  /**
   * El estado lo mueve el cobro, no el reloj: entre que vence la prueba y
   * llega el webhook hay una ventana donde el estado todavía dice `trialing`
   * pero la fecha ya pasó. Mandan los hechos, no la etiqueta.
   */
  it("deja de estar en prueba cuando la fecha ya pasó, aunque el estado no se haya movido", () => {
    expect(isInTrial(trialEndingIn(-1), NOW)).toBe(false);
  });

  // Justo en el instante del vencimiento la prueba ya terminó.
  it("no está en prueba justo al vencer", () => {
    expect(isInTrial({ status: "trialing", trialEndsAt: NOW }, NOW)).toBe(false);
  });

  it("una suscripción paga no está en prueba aunque le quede fecha", () => {
    expect(
      isInTrial({ status: "active", trialEndsAt: trialEndingIn(5).trialEndsAt }, NOW),
    ).toBe(false);
  });

  it("sin fecha de prueba no hay prueba", () => {
    expect(isInTrial({ status: "trialing", trialEndsAt: null }, NOW)).toBe(false);
  });
});

describe("trialDaysLeft", () => {
  it("cuenta los días que faltan", () => {
    expect(trialDaysLeft(trialEndingIn(5), NOW)).toBe(5);
  });

  /**
   * Redondea PARA ARRIBA: a alguien que le quedan 18 horas le queda "1 día",
   * no cero. Mostrar cero mientras el servicio todavía anda es mentirle.
   */
  it("una fracción de día cuenta como un día", () => {
    const trialEndsAt = new Date("2026-08-18T06:00:00Z"); // 18 horas

    expect(trialDaysLeft({ status: "trialing", trialEndsAt }, NOW)).toBe(1);
  });

  it("vencida no quedan días", () => {
    expect(trialDaysLeft(trialEndingIn(-3), NOW)).toBe(0);
  });

  it("sin prueba no quedan días", () => {
    expect(trialDaysLeft({ status: "active", trialEndsAt: null }, NOW)).toBe(0);
  });
});
