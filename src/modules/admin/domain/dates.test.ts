import { describe, expect, it } from "vitest";

import { utcDateLabel } from "./dates";

describe("utcDateLabel", () => {
  it("formatea la fecha en castellano", () => {
    expect(utcDateLabel("2026-08-01T00:00:00Z")).toBe("1 ago 2026");
  });

  /**
   * La misma fecha tiene que verse igual sin importar dónde corra el render.
   *
   * Acá no hay un negocio cuya zona horaria usar —se listan todos, de países
   * distintos— así que dejarlo a la tz del servidor haría que una misma alta
   * cayera un día u otro según la máquina. UTC es arbitrario, pero es igual
   * para todos.
   *
   * Este instante es medianoche UTC: en Buenos Aires (UTC-3) es el día
   * ANTERIOR a las 21hs, así que un formateo en hora local devolvería
   * "31 jul" y este test lo caza.
   */
  it("usa UTC y no la zona horaria de quien renderiza", () => {
    expect(utcDateLabel("2026-08-01T00:00:00Z")).not.toBe("31 jul 2026");
  });

  /**
   * `created_at` llega de PostgREST como `string` por un cast sin validar, y
   * ante un valor impareseable `format` tira `RangeError`. Esta función corre
   * adentro de un `map`, así que esa excepción no se lleva una fila: se lleva
   * la lista ENTERA, y el operador ve una pantalla rota por culpa de un dato.
   * Un guion es una fila fea; una excepción es una pantalla que no existe.
   */
  it("devuelve un guion en vez de tirar cuando la fecha no se puede leer", () => {
    expect(utcDateLabel("no es una fecha")).toBe("—");
  });

  it("tampoco tira con una cadena vacía", () => {
    expect(utcDateLabel("")).toBe("—");
  });
});
