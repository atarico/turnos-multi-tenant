import { describe, expect, it } from "vitest";

import { priceUsdCentsFor, usdCentsToArsCents } from "./price";

/**
 * El precio de los planes vive en dólares y se cobra en pesos. Esta conversión
 * es lo único que une las dos cosas, y se corre UNA vez —en el checkout— con
 * la cotización del día, que después queda guardada en la suscripción.
 *
 * La tasa se pasa como parámetro. Buscarla adentro haría que el precio dependa
 * de la red y que estos tests salgan a internet.
 */

describe("priceUsdCentsFor", () => {
  it("los planes valen 15, 35 y 70 dólares", () => {
    expect(priceUsdCentsFor("basico")).toBe(1500);
    expect(priceUsdCentsFor("pro")).toBe(3500);
    expect(priceUsdCentsFor("premium")).toBe(7000);
  });

  /**
   * Igual que con los límites, se prueba la RELACIÓN y no sólo los números: un
   * plan más caro tiene que costar más que el anterior, o la tabla de precios
   * no se puede explicar.
   */
  it("cada plan cuesta más que el anterior", () => {
    expect(priceUsdCentsFor("pro")).toBeGreaterThan(priceUsdCentsFor("basico"));
    expect(priceUsdCentsFor("premium")).toBeGreaterThan(priceUsdCentsFor("pro"));
  });

  /**
   * `PlanTier` es una unión de TypeScript, y el valor real viene de una columna
   * de la base. Si alguien agrega un valor al enum de Postgres sin tocar esta
   * tabla, el lookup devolvía `undefined` y se propagaba como `NaN` hasta el
   * monto cobrado. Un plan desconocido tiene que romper acá, fuerte y cerca del
   * origen.
   */
  it("un plan que no está en la tabla rompe, no devuelve undefined", () => {
    expect(() =>
      priceUsdCentsFor("enterprise" as Parameters<typeof priceUsdCentsFor>[0]),
    ).toThrow();
  });

  /**
   * Una clave HEREDADA de `Object.prototype` no da `undefined` sino una
   * función, así que un guard por `=== undefined` la dejaba pasar. El chequeo
   * tiene que preguntar por la clave PROPIA.
   */
  it("una clave heredada del prototipo tampoco pasa", () => {
    expect(() =>
      priceUsdCentsFor("toString" as Parameters<typeof priceUsdCentsFor>[0]),
    ).toThrow();
  });
});

describe("usdCentsToArsCents", () => {
  it("convierte a la cotización dada", () => {
    // USD 35 a 1300 pesos = 45.500 pesos = 4.550.000 centavos
    expect(usdCentsToArsCents(3500, 1300)).toBe(4550000);
  });

  /**
   * Redondea HACIA ARRIBA al peso entero. Dos razones: un precio con centavos
   * de peso no se le muestra a nadie, y redondear para abajo sería cobrar de
   * menos. La diferencia máxima es un peso.
   */
  it("redondea hacia arriba al peso entero", () => {
    // USD 15 a 1300,50 = 19.507,50 pesos → 19.508 pesos
    expect(usdCentsToArsCents(1500, 1300.5)).toBe(1950800);
  });

  it("un monto que ya da pesos enteros no se mueve", () => {
    expect(usdCentsToArsCents(1000, 1000)).toBe(1000000);
  });

  /**
   * Durante la prueba gratis el precio es cero. Convertir cero tiene que dar
   * cero y no el primer peso del redondeo hacia arriba.
   */
  it("cero sigue siendo cero", () => {
    expect(usdCentsToArsCents(0, 1300.5)).toBe(0);
  });

  /**
   * Una cotización inválida no puede producir un precio: sería cobrar un
   * número inventado. Se rompe fuerte porque no hay valor de retorno honesto
   * — cero cobraría de menos y un default cobraría cualquier cosa.
   */
  it("una cotización que no es positiva es un error, no un precio", () => {
    expect(() => usdCentsToArsCents(3500, 0)).toThrow();
    expect(() => usdCentsToArsCents(3500, -1300)).toThrow();
    expect(() => usdCentsToArsCents(3500, Number.NaN)).toThrow();
  });

  /**
   * El monto se valida igual que la tasa. Validar sólo la mitad de las
   * entradas es peor que no validar ninguna: da la sensación de que la función
   * se defiende cuando en realidad un `NaN` del lado del monto salía como
   * `NaN` —un valor de retorno, no un error— y quien llamaba no tenía cómo
   * distinguirlo de un precio.
   */
  it("un monto inválido también es un error, no un precio", () => {
    expect(() => usdCentsToArsCents(Number.NaN, 1300)).toThrow();
    expect(() => usdCentsToArsCents(-3500, 1300)).toThrow();
    expect(() => usdCentsToArsCents(Number.POSITIVE_INFINITY, 1300)).toThrow();
  });

  /**
   * Validar las ENTRADAS no alcanza. Estos dos números pasan los dos guards
   * —son finitos, uno positivo y el otro no negativo— y su producto desborda
   * igual. `Infinity` saldría como valor de retorno, indistinguible de un
   * precio para quien llama. Se chequea el RESULTADO, no sólo lo que entró.
   */
  it("un producto que desborda es un error, no Infinity", () => {
    expect(() => usdCentsToArsCents(7000, 1e308)).toThrow();
  });
});
