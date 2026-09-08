import { describe, expect, it } from "vitest";

import { effectivePlan, type CourtesyView } from "./courtesy";

const NOW = new Date("2026-08-30T12:00:00Z");

function view(overrides: Partial<CourtesyView> = {}): CourtesyView {
  return {
    plan: "basico",
    planCourtesy: null,
    planCourtesyUntil: null,
    ...overrides,
  };
}

describe("effectivePlan", () => {
  it("sin cortesía, manda el plan pagado", () => {
    expect(effectivePlan(view({ plan: "pro" }), NOW)).toBe("pro");
  });

  it("con una cortesía viva, manda la cortesía", () => {
    expect(
      effectivePlan(view({ plan: "basico", planCourtesy: "premium" }), NOW),
    ).toBe("premium");
  });

  /** Sin fecha de fin, la cortesía dura hasta que el operador la saque. */
  it("una cortesía sin vencimiento sigue viva", () => {
    expect(
      effectivePlan(
        view({ plan: "basico", planCourtesy: "pro", planCourtesyUntil: null }),
        NOW,
      ),
    ).toBe("pro");
  });

  it("una cortesía con vencimiento futuro sigue viva", () => {
    expect(
      effectivePlan(
        view({
          plan: "basico",
          planCourtesy: "premium",
          planCourtesyUntil: new Date("2026-09-30T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe("premium");
  });

  /**
   * El vencimiento tiene que caducar SOLO, sin que corra ninguna tarea.
   *
   * Ésta es la razón de que el plan efectivo se calcule al leer en vez de
   * escribirse en `tenants.plan` cuando se otorga: no hay nada agendado en este
   * proyecto que pueda apagar una cortesía el día que corresponde, y una que
   * no caduca sola es una que se regala para siempre por olvido.
   */
  it("una cortesía vencida ya no cuenta", () => {
    expect(
      effectivePlan(
        view({
          plan: "basico",
          planCourtesy: "premium",
          planCourtesyUntil: new Date("2026-08-01T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe("basico");
  });

  /** El instante exacto del vencimiento ya está afuera: la fecha es un tope. */
  it("caduca en el instante mismo del vencimiento, no después", () => {
    expect(
      effectivePlan(
        view({ plan: "basico", planCourtesy: "premium", planCourtesyUntil: NOW }),
        NOW,
      ),
    ).toBe("basico");
  });

  /**
   * LA PROTECCIÓN QUE MÁS IMPORTA.
   *
   * Un operador que se equivoca de fila y le regala `basico` a alguien que paga
   * `premium` NO puede dejarlo peor de lo que estaba. La cortesía es un regalo:
   * si el regalo vale menos que lo que la persona ya compró, no cambia nada.
   *
   * Sin esta regla, un click equivocado le saca profesionales activos a un
   * cliente que pagó por ellos, y el negocio se entera cuando no puede trabajar.
   */
  it("nunca deja a un negocio peor de lo que ya pagaba", () => {
    expect(
      effectivePlan(view({ plan: "premium", planCourtesy: "basico" }), NOW),
    ).toBe("premium");
  });

  it("tampoco lo baja de pro a basico", () => {
    expect(effectivePlan(view({ plan: "pro", planCourtesy: "basico" }), NOW)).toBe(
      "pro",
    );
  });

  it("con el mismo plan de los dos lados no cambia nada", () => {
    expect(effectivePlan(view({ plan: "pro", planCourtesy: "pro" }), NOW)).toBe(
      "pro",
    );
  });

  /**
   * Una fecha de fin sin cortesía es un estado imposible que la base impide con
   * un CHECK, pero esta función no puede confiar en eso: la fila llega por un
   * cast sin validar desde PostgREST. Ante datos incoherentes, el plan pagado.
   */
  it("ignora un vencimiento suelto sin plan de cortesía", () => {
    expect(
      effectivePlan(
        view({
          plan: "pro",
          planCourtesy: null,
          planCourtesyUntil: new Date("2027-01-01T00:00:00Z"),
        }),
        NOW,
      ),
    ).toBe("pro");
  });
});
