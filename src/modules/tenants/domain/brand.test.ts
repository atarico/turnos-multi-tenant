import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRAND_COLOR,
  normalizeBrandColor,
  readableTextOn,
} from "./brand";

/**
 * El color de marca no es un dato decorativo: termina inyectado como VALOR CSS
 * en la página pública del negocio (`--brand`). Cualquier string que se cuele
 * entero hasta ahí puede cerrar la declaración y abrir otra.
 *
 * Por eso la validación es una lista blanca de forma exacta (`#rrggbb`) y no
 * una lista negra de caracteres peligrosos: con lista blanca, lo que no entra
 * en el molde no pasa, y no hay que anticipar cada payload posible.
 */
describe("normalizeBrandColor", () => {
  it("accepts a six-digit hex color", () => {
    expect(normalizeBrandColor("#6366f1")).toBe("#6366f1");
  });

  it("lowercases so the stored value is comparable", () => {
    expect(normalizeBrandColor("#AABBCC")).toBe("#aabbcc");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeBrandColor("  #6366f1  ")).toBe("#6366f1");
  });

  // `<input type="color">` serializa SIEMPRE como `#rrggbb`, así que la forma
  // corta no llega nunca desde nuestra UI. Se rechaza en vez de expandirse:
  // una sola forma válida es una invariante más fácil de sostener.
  it("rejects the three-digit shorthand", () => {
    expect(normalizeBrandColor("#fff")).toBeNull();
  });

  it("rejects a color name", () => {
    expect(normalizeBrandColor("red")).toBeNull();
  });

  it("rejects hex without the leading hash", () => {
    expect(normalizeBrandColor("6366f1")).toBeNull();
  });

  it("rejects an empty value", () => {
    expect(normalizeBrandColor("")).toBeNull();
    expect(normalizeBrandColor("   ")).toBeNull();
  });

  // Lo que de verdad importa: un valor que PARECE un color y sigue con otra
  // declaración. Si esto pasara, el negocio podría reescribir el estilo de su
  // propia página pública, que es la que ven sus clientes.
  it.each([
    "#6366f1; background-image: url(https://evil.example/x.png)",
    "#6366f1;}html{display:none",
    "#6366f1 !important",
    "var(--something)",
    "expression(alert(1))",
    "#6366f1\n;color:red",
  ])("rejects a value that smuggles extra CSS: %s", (payload) => {
    expect(normalizeBrandColor(payload)).toBeNull();
  });

  it("exposes a default that is itself valid", () => {
    expect(normalizeBrandColor(DEFAULT_BRAND_COLOR)).toBe(DEFAULT_BRAND_COLOR);
  });
});

/**
 * El negocio elige un color cualquiera, así que NINGÚN color de texto fijo sirve
 * para todos: blanco desaparece sobre amarillo, negro desaparece sobre azul
 * marino. El texto se elige según el brillo del fondo.
 *
 * El umbral sale de la fórmula de luminancia relativa de WCAG: por encima de
 * ~0.179 el negro contrasta mejor, por debajo el blanco. No es una preferencia
 * estética, es el punto donde se cruzan las dos relaciones de contraste.
 */
describe("readableTextOn", () => {
  it.each([
    ["#ffffff", "#000000", "blanco puro"],
    ["#ffff00", "#000000", "amarillo"],
    ["#f1f5f9", "#000000", "gris muy claro"],
    ["#000000", "#ffffff", "negro puro"],
    ["#1e293b", "#ffffff", "azul marino"],
  ])("sobre %s usa %s (%s)", (background, expected) => {
    expect(readableTextOn(background)).toBe(expected);
  });

  // Parece un error y no lo es: el indigo por defecto tiene luminancia 0.1876,
  // apenas por encima del umbral. Contra negro contrasta 4.75:1 y contra blanco
  // 4.42:1, así que negro gana — por poco. Queda anotado porque es justo el
  // caso donde alguien va a leer el resultado, decir "esto está al revés", y
  // "arreglarlo" rompiendo la fórmula.
  //
  // El dato de fondo: NINGUNA de las dos opciones llega a 4.5:1 en texto chico.
  // El default de la base es un color mediocre para acentuar sobre él.
  it("elige negro sobre el indigo por defecto, que está al filo del umbral", () => {
    expect(readableTextOn(DEFAULT_BRAND_COLOR)).toBe("#000000");
  });

  // El verde pesa mucho más que el azul en la percepción de brillo: dos colores
  // con el mismo valor numérico por canal no se ven igual de claros. Si la
  // fórmula promediara los canales en vez de ponderarlos, estos dos caerían del
  // mismo lado y uno quedaría ilegible.
  it("pondera los canales en vez de promediarlos", () => {
    expect(readableTextOn("#00ff00")).toBe("#000000");
    expect(readableTextOn("#0000ff")).toBe("#ffffff");
  });

  it("cae a texto claro si el color no es válido, que es el fondo más probable", () => {
    expect(readableTextOn("no-es-un-color")).toBe("#ffffff");
  });
});
