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

/**
 * El item de la lista de features que contiene ese texto.
 *
 * Va por el `li` y no por `getByText` porque el texto de cada feature está
 * partido en varios nodos (`{option.staff}` + " " + "profesionales"), y un
 * matcher de texto plano no cruza esa frontera: buscaría un solo nodo y no
 * encontraría nada. Además es lo que hace falta para preguntar por el CARTEL,
 * que es hermano del texto, no parte de él.
 */
function featureItem(pattern: RegExp): HTMLElement {
  const item = [...document.querySelectorAll("li")].find((li) =>
    pattern.test(li.textContent ?? ""),
  );
  if (!item) throw new Error(`Ningún feature de plan matchea ${pattern}`);
  return item;
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

  /**
   * El cupón se escribe UNA vez y viaja con el plan que se apriete.
   *
   * Cada plan tiene su propio <form>, así que un input suelto afuera no se
   * enviaría con ninguno. Lo que se fija acá es que lo tipeado llegue al form
   * de CADA tarjeta: si sólo llegara al primero, el dueño escribe el código,
   * aprieta Premium y le cobran el precio entero sin que nadie le avise.
   */
  it("manda el cupón tipeado con cualquiera de los planes", async () => {
    const user = userEvent.setup();
    setup({ currentPlan: "basico" });

    await user.type(screen.getByLabelText(/tenés un cupón/i), "beta99");

    const ocultos = document.querySelectorAll<HTMLInputElement>(
      'input[type="hidden"][name="coupon"]',
    );
    expect(ocultos).toHaveLength(3);
    for (const input of ocultos) {
      expect(input.value).toBe("beta99");
    }
  });

  it("sin cupón, el campo viaja vacío y no rompe nada", () => {
    setup({ currentPlan: "basico" });

    const ocultos = document.querySelectorAll<HTMLInputElement>(
      'input[type="hidden"][name="coupon"]',
    );
    expect(ocultos).toHaveLength(3);
    expect([...ocultos].every((i) => i.value === "")).toBe(true);
  });

  /**
   * WhatsApp NO existe todavía: no hay una sola línea en el proyecto que mande
   * un mensaje (`rg -ni whatsapp src` sólo devuelve texto de venta). Es el
   * último punto de la hoja de ruta.
   *
   * Mientras no exista, la tilde dorada al lado de "800 mensajes de WhatsApp"
   * es una promesa que el producto no puede cumplir, y quien la lee está a un
   * clic de poner la tarjeta. El mismo criterio que el aviso del cambio de
   * moneda: una sorpresa sobre lo que se paga es un reclamo esperando a pasar.
   */
  it("no vende WhatsApp como incluido: lo marca como próximamente", () => {
    setup();

    expect(featureItem(/800 mensajes de WhatsApp/)).toHaveTextContent(
      /próximamente/i,
    );
    expect(featureItem(/2000 mensajes de WhatsApp/)).toHaveTextContent(
      /próximamente/i,
    );
  });

  it("lo que SÍ funciona no queda marcado como próximamente", () => {
    // Si el cartel se pegara a toda la lista, el picker pasaría de vender de
    // más a vender de menos: el límite de profesionales se hace cumplir de
    // verdad (`staff/application/actions.ts`) y el techo de turnos se muestra.
    setup();

    expect(featureItem(/5 profesionales/)).not.toHaveTextContent(
      /próximamente/i,
    );
    expect(featureItem(/1500 turnos por mes/)).not.toHaveTextContent(
      /próximamente/i,
    );
  });

  it("en Básico WhatsApp es una exclusión, no una espera", () => {
    // Básico no lo va a tener nunca, aunque WhatsApp se construya mañana.
    // Decirle "próximamente" sería prometerle algo que su plan no incluye.
    setup();

    const item = featureItem(/Sin WhatsApp/);
    expect(item).not.toHaveTextContent(/próximamente/i);
  });
});
