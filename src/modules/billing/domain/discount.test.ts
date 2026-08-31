import { describe, expect, it } from "vitest";

import { applyDiscount } from "./discount";

/** $23.111 en centavos, el Premium a una cotización cualquiera. */
const PRECIO = 2_311_100;

describe("applyDiscount", () => {
  it("sin descuento devuelve el mismo monto", () => {
    expect(applyDiscount(PRECIO, 0)).toBe(PRECIO);
  });

  it("un 50% cobra la mitad", () => {
    expect(applyDiscount(1_000_000, 5000)).toBe(500_000);
  });

  /** El caso que motivó los cupones: probar el cobro real sin gastar. */
  it("un 99% deja un monto simbólico", () => {
    expect(applyDiscount(PRECIO, 9900)).toBe(23_200);
  });

  /**
   * Mismo criterio que `usdCentsToArsCents`: se redondea HACIA ARRIBA al peso
   * entero. Un monto con centavos de peso no se le muestra a nadie, y hacia
   * abajo cobraría menos que el descuento pactado. El costo máximo es un peso.
   */
  it("redondea hacia arriba al peso entero", () => {
    // 10.000 centavos - 33% = 6.700 exactos; con 3333 bps da 6667 → sube a 6700.
    expect(applyDiscount(10_000, 3333) % 100).toBe(0);
    expect(applyDiscount(10_000, 3333)).toBe(6_700);
  });

  /**
   * Nunca cero. Un preapproval en cero lo rechaza Mercado Pago, y el rechazo
   * llegaría recién en el checkout, de cara al cliente. El techo de 9900 en la
   * base hace que este piso casi no se toque; casi no es nunca.
   */
  it("nunca devuelve cero", () => {
    expect(applyDiscount(100, 9900)).toBeGreaterThan(0);
  });

  it("rompe ante un monto inválido en vez de inventar uno", () => {
    expect(() => applyDiscount(Number.NaN, 1000)).toThrow();
    expect(() => applyDiscount(-1, 1000)).toThrow();
  });

  /**
   * Un descuento fuera de rango NO se recorta al borde: recortar cobraría un
   * precio que nadie pactó y lo haría en silencio. El 10000 entra acá aunque la
   * base no lo permita — esta función no puede confiar en que su único llamador
   * de hoy siga siendo el único mañana.
   */
  it("rompe ante un descuento fuera de rango", () => {
    expect(() => applyDiscount(PRECIO, -1)).toThrow();
    expect(() => applyDiscount(PRECIO, 10_001)).toThrow();
    expect(() => applyDiscount(PRECIO, Number.NaN)).toThrow();
  });

  it("acepta el 100% como número, aunque la base no lo permita", () => {
    expect(applyDiscount(PRECIO, 10_000)).toBeGreaterThan(0);
  });
});
