import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, idleState } from "@/core/action";
import type { PlanCourtesy } from "@/modules/admin/domain/types";

import { CourtesyPanel } from "./courtesy-panel";

/**
 * Tests del panel de cortesía.
 *
 * La autorización NO se prueba acá: vive en `is_super_admin()` adentro de las
 * funciones de la base, y está cubierta en `supabase/tests/plan_courtesy.sql`.
 * Este componente no puede otorgar nada por su cuenta; lo único que hace es
 * ofrecer el formulario correcto para el estado en el que está el negocio.
 *
 * Lo que se fija acá es justamente eso: que los dos estados sean EXCLUYENTES.
 * Un panel que muestre el formulario de otorgar mientras ya hay una cortesía
 * viva invita al operador a pisar un regalo sin ver el que existe —y con él, el
 * motivo por el que se dio.
 */

const noop = vi.fn(async (): Promise<ActionState> => idleState);

const courtesy: PlanCourtesy = {
  plan: "premium",
  until: null,
  reason: "beta tester",
  grantedAt: "2026-08-30T00:00:00Z",
};

function setup(overrides: { courtesy?: PlanCourtesy | null } = {}) {
  return render(
    <CourtesyPanel
      tenantId="00000000-0000-0000-0000-000000000001"
      slug="acme"
      paidPlan="basico"
      courtesy={overrides.courtesy ?? null}
      grant={noop}
      revoke={noop}
    />,
  );
}

describe("CourtesyPanel", () => {
  it("sin cortesía, ofrece otorgar una", () => {
    setup();

    expect(screen.getByLabelText(/plan a regalar/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/motivo/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /otorgar/i })).toBeInTheDocument();
  });

  /**
   * El plan pagado se dice en el formulario para que el operador elija sabiendo.
   * No es decorativo: regalar hacia abajo no hace nada, y sin este dato el
   * operador creería que sí.
   */
  it("sin cortesía, dice qué plan paga hoy el negocio", () => {
    setup();

    // Acotado al párrafo: "Básico" también es una opción del select, y un
    // getByText suelto encuentra las dos y no distingue cuál miró.
    const aviso = screen.getByText(/hoy paga/i);
    expect(within(aviso).getByText("Básico")).toBeInTheDocument();
  });

  it("con cortesía, la muestra con su motivo", () => {
    setup({ courtesy });

    expect(screen.getByText("Premium")).toBeInTheDocument();
    expect(screen.getByText("beta tester")).toBeInTheDocument();
  });

  /** Sin fecha, el regalo dura hasta que lo saquen. Se dice, no se deja en blanco. */
  it("con cortesía sin vencimiento, lo dice con palabras", () => {
    setup({ courtesy });

    expect(screen.getByText(/sin vencimiento/i)).toBeInTheDocument();
  });

  it("con cortesía con vencimiento, muestra la fecha", () => {
    setup({ courtesy: { ...courtesy, until: "2026-12-01T00:00:00Z" } });

    expect(screen.getByText(/hasta el 2026-12-01/)).toBeInTheDocument();
    expect(screen.queryByText(/sin vencimiento/i)).toBeNull();
  });

  it("con cortesía, ofrece quitarla", () => {
    setup({ courtesy });

    expect(
      screen.getByRole("button", { name: /quitar la cortesía/i }),
    ).toBeInTheDocument();
  });

  /**
   * Los dos estados son excluyentes. Si el formulario de otorgar siguiera a la
   * vista con una cortesía viva, el operador pisaría el regalo existente sin
   * llegar a ver su motivo, que es el dato que explica por qué está ahí.
   */
  it("con cortesía, NO ofrece otorgar otra encima", () => {
    setup({ courtesy });

    expect(screen.queryByLabelText(/plan a regalar/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^otorgar/i })).toBeNull();
  });

  it("sin cortesía, no ofrece quitar nada", () => {
    setup();

    expect(screen.queryByRole("button", { name: /quitar/i })).toBeNull();
  });
});
