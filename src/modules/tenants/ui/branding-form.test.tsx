import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import { BrandingForm } from "./branding-form";

const spySave = (result: ActionState = idleState) =>
  vi.fn(async () => result) as unknown as (
    prev: ActionState,
    formData: FormData,
  ) => Promise<ActionState>;

const colorInput = () => screen.getByLabelText("Color de marca");

describe("BrandingForm", () => {
  it("arranca con el color que ya tiene el negocio", () => {
    render(<BrandingForm brandColor="#aabbcc" save={spySave()} />);

    expect(colorInput()).toHaveValue("#aabbcc");
  });

  // El input es CONTROLADO a propósito. React 19 hace `requestFormReset` al
  // resolver la action, y un input no controlado vuelve a su `defaultValue`:
  // el dueño elegía un color, guardaba, y la pantalla le mostraba el anterior.
  // Es el mismo bug que ya nos comimos en el editor de horarios.
  it("conserva el color elegido después de guardar", async () => {
    render(
      <BrandingForm
        brandColor="#aabbcc"
        save={spySave({ status: "success", message: "Listo" })}
      />,
    );

    fireEvent.change(colorInput(), { target: { value: "#ff0000" } });
    await userEvent.click(screen.getByRole("button", { name: /guardar/i }));

    expect(colorInput()).toHaveValue("#ff0000");
  });

  it("muestra el error del campo que devuelve la acción", async () => {
    render(
      <BrandingForm
        brandColor="#aabbcc"
        save={spySave(
          errorState("Revisá los datos del formulario.", {
            brandColor: "Elegí un color válido.",
          }),
        )}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /guardar/i }));

    expect(await screen.findByText("Elegí un color válido.")).toBeInTheDocument();
  });

  // El cartel de éxito de una pantalla de configuración se queda pegado para
  // siempre si nadie lo limpia, y termina mintiendo: dice "guardado" mientras
  // el usuario tiene en pantalla un color que NO guardó.
  it("baja el cartel de éxito en cuanto el usuario vuelve a tocar el color", async () => {
    render(
      <BrandingForm
        brandColor="#aabbcc"
        save={spySave({ status: "success", message: "Listo, guardamos tu color." })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /guardar/i }));
    expect(
      await screen.findByText("Listo, guardamos tu color."),
    ).toBeInTheDocument();

    fireEvent.change(colorInput(), { target: { value: "#00ff00" } });

    expect(
      screen.queryByText("Listo, guardamos tu color."),
    ).not.toBeInTheDocument();
  });

  /**
   * El flujo REAL, que ningún test cubría: el usuario cambia el color, guarda,
   * y el server component se vuelve a renderizar con el color ya guardado
   * gracias al `revalidatePath` de la action. El `rerender` con el nuevo
   * `brandColor` simula exactamente ese refresco.
   *
   * Es la mitad que importa de `showSuccess`: sin ella sólo estaba probado el
   * caso trivial en que el usuario guarda sin haber cambiado nada.
   */
  it("confirma el guardado cuando el servidor devuelve el color nuevo", async () => {
    const save = spySave({
      status: "success",
      message: "Listo, guardamos tu color.",
    });
    const { rerender } = render(
      <BrandingForm brandColor="#aabbcc" save={save} />,
    );

    fireEvent.change(colorInput(), { target: { value: "#ff0000" } });
    await userEvent.click(screen.getByRole("button", { name: /guardar/i }));

    rerender(<BrandingForm brandColor="#ff0000" save={save} />);

    expect(
      await screen.findByText("Listo, guardamos tu color."),
    ).toBeInTheDocument();
  });

  /**
   * La contracara, documentada a propósito: el cartel depende de que el prop
   * llegue refrescado. Si el servidor confirmara el guardado pero devolviera el
   * color viejo, no habría confirmación en pantalla. Queda pinchado acá para
   * que el acoplamiento sea visible y no una sorpresa.
   */
  it("no confirma si el servidor dice ok pero devuelve el color viejo", async () => {
    const save = spySave({
      status: "success",
      message: "Listo, guardamos tu color.",
    });
    render(<BrandingForm brandColor="#aabbcc" save={save} />);

    fireEvent.change(colorInput(), { target: { value: "#ff0000" } });
    await userEvent.click(screen.getByRole("button", { name: /guardar/i }));

    expect(
      screen.queryByText("Listo, guardamos tu color."),
    ).not.toBeInTheDocument();
  });

  it("manda el color al servidor bajo el nombre que la acción espera", async () => {
    const save = spySave();
    render(<BrandingForm brandColor="#aabbcc" save={save} />);

    fireEvent.change(colorInput(), { target: { value: "#123456" } });
    await userEvent.click(screen.getByRole("button", { name: /guardar/i }));

    const formData = vi.mocked(save).mock.calls[0]![1];
    expect(formData.get("brandColor")).toBe("#123456");
  });
});
