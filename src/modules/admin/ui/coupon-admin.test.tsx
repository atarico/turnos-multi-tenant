import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, idleState } from "@/core/action";
import type { Coupon } from "@/modules/admin/domain/coupon";

import { CouponAdmin } from "./coupon-admin";

/**
 * Tests de la pantalla de cupones del operador.
 *
 * La autorización no se prueba acá: vive en `is_super_admin()` adentro de las
 * funciones de la base, cubierta en `supabase/tests/coupon_admin.sql`.
 *
 * Lo que se fija acá es que el operador pueda VER en qué estado está cada
 * cupón y qué botón le corresponde. Un cupón agotado y uno apagado se arreglan
 * distinto, y confundirlos lo manda a tocar lo que no es.
 */

const noop = vi.fn(async (): Promise<ActionState> => idleState);
const NOW = "2026-08-31T12:00:00.000Z";

function coupon(over: Partial<Coupon> = {}): Coupon {
  return {
    code: "BETA99",
    discount_bps: 9900,
    active: true,
    expires_at: null,
    max_redemptions: null,
    redemptions: 0,
    note: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function setup(coupons: Coupon[]) {
  return render(
    <CouponAdmin coupons={coupons} now={NOW} create={noop} toggle={noop} />,
  );
}

describe("CouponAdmin", () => {
  it("ofrece crear un cupón", () => {
    setup([]);

    expect(screen.getByLabelText(/código/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/descuento/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /crear cupón/i }),
    ).toBeInTheDocument();
  });

  it("avisa cuando no hay ninguno, en vez de dejar el hueco vacío", () => {
    setup([]);

    expect(screen.getByText(/todavía no hay cupones/i)).toBeInTheDocument();
  });

  /** Los bps son de la base. En pantalla va el porcentaje. */
  it("muestra el descuento en porcentaje", () => {
    setup([coupon({ discount_bps: 9900 })]);

    expect(screen.getByText("99%")).toBeInTheDocument();
  });

  it("muestra el código y para qué es", () => {
    setup([coupon({ note: "prueba de cobro real" })]);

    expect(screen.getByText("BETA99")).toBeInTheDocument();
    expect(screen.getByText("prueba de cobro real")).toBeInTheDocument();
  });

  /**
   * El estado se dice CON PALABRAS y no sólo con el color del badge: un cupón
   * apagado y uno agotado se arreglan distinto, y distinguirlos por el tono
   * deja afuera a cualquiera que no distinga esos dos tonos.
   */
  it("dice el estado con palabras", () => {
    setup([
      coupon({ code: "UNO" }),
      coupon({ code: "DOS", active: false }),
      coupon({ code: "TRES", expires_at: "2026-08-01T00:00:00Z" }),
      coupon({ code: "CUATRO", max_redemptions: 1, redemptions: 1 }),
    ]);

    const filas = screen.getAllByRole("listitem");
    expect(within(filas[0]).getByText("Activo")).toBeInTheDocument();
    expect(within(filas[1]).getByText("Apagado")).toBeInTheDocument();
    expect(within(filas[2]).getByText("Vencido")).toBeInTheDocument();
    expect(within(filas[3]).getByText("Agotado")).toBeInTheDocument();
  });

  /**
   * El botón dice la ACCIÓN, no el estado. "Apagar" sobre un cupón encendido y
   * "Encender" sobre uno apagado: si dijera el estado, el operador tendría que
   * adivinar si el botón describe lo que hay o lo que va a pasar.
   */
  it("el botón ofrece lo contrario de lo que el cupón está", () => {
    setup([coupon({ code: "ON" }), coupon({ code: "OFF", active: false })]);

    const filas = screen.getAllByRole("listitem");
    expect(
      within(filas[0]).getByRole("button", { name: "Apagar" }),
    ).toBeInTheDocument();
    expect(
      within(filas[1]).getByRole("button", { name: "Encender" }),
    ).toBeInTheDocument();
  });

  /**
   * El estado deseado viaja en el form y no se deduce del actual en el
   * servidor: dos clicks seguidos leerían el mismo valor y el segundo desharía
   * al primero sin que nadie lo pidiera.
   */
  it("manda el estado deseado, no el actual", () => {
    setup([coupon({ code: "ON", active: true })]);

    const oculto = document.querySelector<HTMLInputElement>(
      'input[name="active"]',
    );
    expect(oculto?.value).toBe("false");
  });

  it("muestra el uso contra el tope cuando hay tope", () => {
    setup([coupon({ max_redemptions: 5, redemptions: 2 })]);

    expect(screen.getByText(/2 de 5 usos/)).toBeInTheDocument();
  });

  it("dice sin tope cuando no lo hay", () => {
    setup([coupon({ redemptions: 7 })]);

    expect(screen.getByText(/7 usos · sin tope/)).toBeInTheDocument();
  });
});
