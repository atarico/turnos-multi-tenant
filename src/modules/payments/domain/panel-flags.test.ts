import { describe, expect, it } from "vitest";

import { classifyToggleError, parsePaymentsFlag, PAYMENTS_FLAGS } from "./panel-flags";

describe("parsePaymentsFlag", () => {
  it("reconoce cada bandera fija", () => {
    for (const flag of Object.keys(PAYMENTS_FLAGS)) {
      expect(parsePaymentsFlag(flag)).toBe(flag);
    }
  });

  it("descarta todo lo que no sea una bandera conocida", () => {
    expect(parsePaymentsFlag(undefined)).toBeNull();
    expect(parsePaymentsFlag(["conectado"])).toBeNull();
    expect(parsePaymentsFlag("Escribinos al WhatsApp 555")).toBeNull();
    // Claves heredadas del prototipo no cuentan como banderas.
    expect(parsePaymentsFlag("toString")).toBeNull();
    expect(parsePaymentsFlag("__proto__")).toBeNull();
  });
});

describe("classifyToggleError", () => {
  it("42501 es que no es el dueño", () => {
    expect(classifyToggleError({ code: "42501", message: "x" })).toBe("sin-permiso");
  });

  it("distingue falta de plan de falta de conexión", () => {
    expect(
      classifyToggleError({
        code: "P0001",
        message: "Los cobros online requieren el plan Pro o superior",
      }),
    ).toBe("sin-plan");
    expect(
      classifyToggleError({ code: "P0001", message: "Mercado Pago no está conectado" }),
    ).toBe("sin-conexion");
  });

  it("cualquier otra cosa es un fallo genérico", () => {
    expect(classifyToggleError({ code: "XX000", message: "boom" })).toBe("fallo");
    expect(classifyToggleError({})).toBe("fallo");
  });
});
