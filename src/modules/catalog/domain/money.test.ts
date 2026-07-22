import { describe, expect, it } from "vitest";

import { formatPrice, formatPriceInput, parsePriceToCents } from "./money";

describe("parsePriceToCents", () => {
  it("parses a plain integer amount", () => {
    expect(parsePriceToCents("1500")).toBe(150000);
  });

  it("parses zero", () => {
    expect(parsePriceToCents("0")).toBe(0);
  });

  it("treats a trailing two-digit group as decimals, with either separator", () => {
    expect(parsePriceToCents("1500,50")).toBe(150050);
    expect(parsePriceToCents("1500.50")).toBe(150050);
  });

  it("treats a trailing one-digit group as decimals", () => {
    expect(parsePriceToCents("1500,5")).toBe(150050);
  });

  it("treats a trailing three-digit group as a thousands separator", () => {
    expect(parsePriceToCents("1.500")).toBe(150000);
    expect(parsePriceToCents("1,500")).toBe(150000);
  });

  it("resolves mixed separators by position: the last one is the decimal", () => {
    expect(parsePriceToCents("1.500,50")).toBe(150050);
    expect(parsePriceToCents("1,500.50")).toBe(150050);
  });

  it("ignores surrounding whitespace and the currency sign", () => {
    expect(parsePriceToCents("  $ 1.500,50 ")).toBe(150050);
  });

  it("rejects empty, non-numeric and negative input", () => {
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("   ")).toBeNull();
    expect(parsePriceToCents("gratis")).toBeNull();
    expect(parsePriceToCents("-100")).toBeNull();
    expect(parsePriceToCents("1e5")).toBeNull();
  });

  it("rejects an amount with no digits before the decimal separator", () => {
    expect(parsePriceToCents(",50")).toBeNull();
  });

  it("reads a trailing three-digit group as thousands, never as decimals", () => {
    // "10,505" es ambiguo para una persona, pero la regla posicional no lo es:
    // tres cifras al final SIEMPRE agrupan miles. Diez mil quinientos cinco.
    expect(parsePriceToCents("10,505")).toBe(1050500);
  });

  it("rejects a separator that does not group by three", () => {
    expect(parsePriceToCents("1.5000")).toBeNull();
  });
});

describe("formatPrice", () => {
  it("formats cents with es-AR grouping and two decimals", () => {
    expect(formatPrice(150050, "ARS")).toBe("$ 1.500,50");
  });

  it("keeps the decimals even when they are zero", () => {
    expect(formatPrice(150000, "ARS")).toBe("$ 1.500,00");
  });

  it("formats amounts under a thousand without a grouping separator", () => {
    expect(formatPrice(50, "ARS")).toBe("$ 0,50");
  });

  it("groups every three digits in large amounts", () => {
    expect(formatPrice(123456789, "ARS")).toBe("$ 1.234.567,89");
  });

  it("prefixes the ISO code for currencies with no known symbol", () => {
    expect(formatPrice(150000, "CLP")).toBe("CLP 1.500,00");
  });
});

describe("formatPriceInput", () => {
  it("returns an editable amount: no symbol, no grouping, comma decimals", () => {
    expect(formatPriceInput(150050)).toBe("1500,50");
    expect(formatPriceInput(150000)).toBe("1500,00");
    expect(formatPriceInput(0)).toBe("0,00");
  });

  it("round-trips through parsePriceToCents", () => {
    expect(parsePriceToCents(formatPriceInput(123456789))).toBe(123456789);
  });
});
