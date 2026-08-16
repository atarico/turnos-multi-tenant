import { describe, expect, it } from "vitest";

import { wroteRows } from "./db-write";

/**
 * El caso que justifica que esta función exista: PostgREST devuelve
 * `error: null` cuando RLS recorta un UPDATE o un DELETE a cero filas. Para la
 * app eso es indistinguible de una escritura exitosa, y la pantalla termina
 * diciendo "guardado" sobre algo que nunca ocurrió.
 *
 * Sólo aplica a UPDATE y DELETE. Un INSERT bloqueado por RLS SÍ devuelve error
 * (`new row violates row-level security policy`), así que ahí no hace falta.
 */
describe("wroteRows", () => {
  it("es verdadero cuando la base devolvió filas afectadas", () => {
    expect(wroteRows({ data: [{ id: "a" }], error: null })).toBe(true);
  });

  it("es verdadero con varias filas", () => {
    expect(wroteRows({ data: [{ id: "a" }, { id: "b" }], error: null })).toBe(true);
  });

  // EL caso. Éxito según PostgREST, nada escrito en realidad.
  it("es falso cuando no se tocó ninguna fila, aunque no haya error", () => {
    expect(wroteRows({ data: [], error: null })).toBe(false);
  });

  it("es falso cuando hubo un error de verdad", () => {
    expect(wroteRows({ data: [{ id: "a" }], error: { message: "boom" } })).toBe(
      false,
    );
  });

  it("es falso cuando hay error y además no vinieron filas", () => {
    expect(wroteRows({ data: [], error: { message: "boom" } })).toBe(false);
  });

  /**
   * `data` en `null` es lo que devuelve un UPDATE al que NO se le pidió
   * `.select()`: PostgREST responde 204 sin cuerpo. Es la trampa de esta
   * función — sin el `.select()` no hay con qué contar, así que se trata como
   * "no sabemos" y se responde que no, para no afirmar un guardado que nadie
   * confirmó.
   */
  it("es falso cuando falta el select y no hay nada que contar", () => {
    expect(wroteRows({ data: null, error: null })).toBe(false);
  });

  it("es falso si data no es una lista", () => {
    expect(wroteRows({ data: undefined, error: null })).toBe(false);
  });
});
