import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import { PlanPicker, type PlanOption } from "./plan-picker";

/**
 * Tests del selector de planes.
 *
 * Es el único botón del proyecto que le saca plata a alguien todos los meses.
 * Lo que se cuida no es el layout: es que no se pueda abrir una segunda
 * suscripción sobre una que ya está cobrando, y que un fallo se VEA en vez de
 * dejar a la persona apretando.
 */

const options: PlanOption[] = [
  {
    plan: "basico",
    label: "Básico",
    priceUsd: "US$ 15,00",
    staff: 2,
    whatsappMessages: 0,
    bookingsPerMonth: 300,
  },
  {
    plan: "pro",
    label: "Pro",
    priceUsd: "US$ 35,00",
    staff: 5,
    whatsappMessages: 800,
    bookingsPerMonth: 1500,
  },
  {
    plan: "premium",
    label: "Premium",
    priceUsd: "US$ 70,00",
    staff: 15,
    whatsappMessages: 2000,
    bookingsPerMonth: 5000,
  },
];

const noop = async (): Promise<ActionState> => idleState;

function setup(props: Partial<React.ComponentProps<typeof PlanPicker>> = {}) {
  return render(
    <PlanPicker
      options={options}
      currentPlan="basico"
      paying={false}
      start={props.start ?? noop}
      {...props}
    />,
  );
}

describe("PlanPicker", () => {
  it("muestra los tres planes con su precio", () => {
    setup();

    for (const option of options) {
      expect(screen.getByText(option.label)).toBeInTheDocument();
      expect(screen.getByText(option.priceUsd)).toBeInTheDocument();
    }
  });

  it("dice que el precio se cobra en pesos del día", () => {
    // El precio se muestra en dólares pero se COBRA en pesos a la cotización
    // del momento. Callarlo hace que el resumen de la tarjeta sea una
    // sorpresa, y una sorpresa sobre plata es un reclamo.
    setup();

    expect(screen.getByText(/pesos/i)).toBeInTheDocument();
  });

  it("marca cuál es el plan que el negocio usa hoy", () => {
    setup({ currentPlan: "pro" });

    expect(screen.getByText("Tu plan")).toBeInTheDocument();
  });

  it("NO deja volver a contratar el plan que ya se está pagando", () => {
    // Abriría una SEGUNDA suscripción que también cobra. La base no lo frena:
    // `attach_subscription_checkout` estampa sobre la misma fila, así que el
    // freno tiene que estar acá.
    setup({ currentPlan: "pro", paying: true });

    expect(screen.getByRole("button", { name: /plan actual/i })).toBeDisabled();
  });

  it("durante la prueba SÍ deja contratar el mismo plan", () => {
    // En prueba `tenants.plan` ya dice 'basico' y no se está cobrando nada.
    // Deshabilitarlo dejaría al negocio sin forma de empezar a pagar.
    setup({ currentPlan: "basico", paying: false });

    const buttons = screen.getAllByRole("button", { name: /contratar/i });
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toBeEnabled();
  });

  it("manda el plan elegido y no otro", async () => {
    const start = vi.fn(async (_prev: ActionState, formData: FormData) => {
      expect(formData.get("plan")).toBe("premium");
      return idleState;
    });
    setup({ start });

    await userEvent.click(
      screen.getByRole("button", { name: /contratar premium/i }),
    );

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("muestra el error que devuelve la action", async () => {
    const start = async () =>
      errorState("No pudimos abrir la suscripción. Probá de nuevo.");
    setup({ start });

    await userEvent.click(screen.getByRole("button", { name: /contratar pro/i }));

    expect(
      await screen.findByText(/no pudimos abrir la suscripción/i),
    ).toBeInTheDocument();
  });

  it("bloquea TODOS los botones mientras está abriendo el checkout", async () => {
    // Sin esto, dos clics seguidos abren dos suscripciones en Mercado Pago y
    // las dos cobran. El `disabled` no es cosmética: es el freno.
    let resolve: (state: ActionState) => void = () => {};
    const start = () =>
      new Promise<ActionState>((r) => {
        resolve = r;
      });
    setup({ start });

    await userEvent.click(screen.getByRole("button", { name: /contratar pro/i }));

    await waitFor(() => {
      for (const button of screen.getAllByRole("button")) {
        expect(button).toBeDisabled();
      }
    });

    resolve(idleState);
  });
});
