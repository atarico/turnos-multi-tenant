import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import { CancelSubscription } from "./cancel-subscription";

/**
 * Tests de la baja de suscripción.
 *
 * Es el botón que corta un cobro, así que lo que se cuida es lo contrario que
 * en el resto del panel: que NO se apriete sin querer, y que quien lo apriete
 * sepa de antemano las dos cosas que le importan — que no se le va a cobrar
 * más, y que NO pierde lo que ya pagó. Sin esa segunda frase, el dueño que
 * quiere irse a fin de mes no se anima a apretar hoy, y el que sí aprieta cree
 * que perdió el mes.
 */

const noop = async (): Promise<ActionState> => idleState;

function setup(props: Partial<React.ComponentProps<typeof CancelSubscription>> = {}) {
  return render(
    <CancelSubscription
      cancel={noop}
      servesUntil="30 de septiembre"
      {...props}
    />,
  );
}

describe("CancelSubscription", () => {
  /**
   * DOS PASOS, y este es el test que lo fija. Un solo botón "Dar de baja"
   * expuesto entre los planes se aprieta por error, y del otro lado hay una
   * suscripción cancelada en Mercado Pago que no se deshace con un ctrl+Z.
   */
  it("no muestra el botón que confirma hasta que se pide dar de baja", () => {
    setup();

    expect(
      screen.queryByRole("button", { name: /confirmar baja/i }),
    ).not.toBeInTheDocument();
  });

  it("al pedir la baja aparece la confirmación", async () => {
    setup();

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));

    expect(
      screen.getByRole("button", { name: /confirmar baja/i }),
    ).toBeInTheDocument();
  });

  /**
   * LA FRASE QUE MÁS IMPORTA DE TODA LA PANTALLA. La baja corta el cobro y no
   * el servicio: quien pagó hasta fin de mes sigue tomando turnos hasta esa
   * fecha. Si no está escrita, el dueño no tiene forma de saberlo y el botón
   * se vuelve una apuesta.
   */
  it("dice hasta cuándo sigue tomando turnos", async () => {
    setup({ servesUntil: "30 de septiembre" });

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));

    expect(screen.getByText(/30 de septiembre/)).toBeInTheDocument();
  });

  it("se puede volver atrás sin dar de baja nada", async () => {
    const cancel = vi.fn(noop);
    setup({ cancel });

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));
    await userEvent.click(screen.getByRole("button", { name: /no, volver/i }));

    expect(
      screen.queryByRole("button", { name: /confirmar baja/i }),
    ).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("confirmar llama a la action", async () => {
    const cancel = vi.fn(noop);
    setup({ cancel });

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirmar baja/i }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  /**
   * Un fallo se VE. Sin esto, el dueño aprieta, no pasa nada visible, y
   * vuelve a apretar — contra una pasarela que ya recibió el pedido.
   */
  it("muestra el error de la action", async () => {
    const cancel = async (): Promise<ActionState> =>
      errorState("No pudimos comunicarnos con Mercado Pago.");
    setup({ cancel });

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirmar baja/i }));

    expect(
      await screen.findByText(/No pudimos comunicarnos con Mercado Pago\./),
    ).toBeInTheDocument();
  });

  it("muestra la confirmación de éxito", async () => {
    const cancel = async (): Promise<ActionState> => ({
      status: "success",
      message: "Listo, dimos de baja tu suscripción.",
    });
    setup({ cancel });

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirmar baja/i }));

    expect(
      await screen.findByText(/Listo, dimos de baja tu suscripción\./),
    ).toBeInTheDocument();
  });

  /**
   * Y después del éxito el botón NO vuelve. Dejarlo invitaría a apretar de
   * nuevo sobre algo ya hecho: el segundo intento es inofensivo del lado de la
   * base —devuelve `already_canceled`— pero le hace creer al dueño que la
   * primera vez no funcionó.
   */
  it("después de dar de baja no ofrece volver a hacerlo", async () => {
    const cancel = async (): Promise<ActionState> => ({
      status: "success",
      message: "Listo, dimos de baja tu suscripción.",
    });
    setup({ cancel });

    await userEvent.click(screen.getByRole("button", { name: /dar de baja/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirmar baja/i }));

    await screen.findByText(/Listo, dimos de baja/);
    expect(
      screen.queryByRole("button", { name: /confirmar baja/i }),
    ).not.toBeInTheDocument();
  });
});
