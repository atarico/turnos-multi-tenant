import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import { LogoForm } from "./logo-form";

const spy = (result: ActionState = idleState) =>
  vi.fn(async () => result) as unknown as (
    prev: ActionState,
    formData: FormData,
  ) => Promise<ActionState>;

const renderForm = (
  logoUrl: string | null,
  upload = spy(),
  remove = spy(),
) => {
  render(<LogoForm logoUrl={logoUrl} upload={upload} remove={remove} />);
  return { upload, remove };
};

describe("LogoForm", () => {
  it("muestra el logo actual cuando el negocio ya subió uno", () => {
    renderForm("https://cdn.test/storage/t1/logo.png");

    expect(screen.getByRole("img", { name: /logo/i })).toHaveAttribute(
      "src",
      "https://cdn.test/storage/t1/logo.png",
    );
  });

  it("no muestra imagen cuando todavía no hay logo", () => {
    renderForm(null);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  // Ofrecer "sacar el logo" cuando no hay logo es una acción que no puede
  // hacer nada: o falla, o miente diciendo que hizo algo.
  it("ofrece sacar el logo sólo si hay uno", () => {
    const { unmount } = render(
      <LogoForm logoUrl={null} upload={spy()} remove={spy()} />,
    );
    expect(
      screen.queryByRole("button", { name: /sacar/i }),
    ).not.toBeInTheDocument();
    unmount();

    renderForm("https://cdn.test/storage/t1/logo.png");
    expect(screen.getByRole("button", { name: /sacar/i })).toBeInTheDocument();
  });

  it("muestra el error del campo que devuelve la acción", async () => {
    renderForm(
      null,
      spy(
        errorState("Sólo aceptamos PNG, JPG o WEBP.", {
          logo: "Sólo aceptamos PNG, JPG o WEBP.",
        }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: /subir/i }));

    expect(
      await screen.findByText("Sólo aceptamos PNG, JPG o WEBP."),
    ).toBeInTheDocument();
  });

  /**
   * El nombre del campo es un contrato con la acción, que lee
   * `formData.get("logo")`. Si se desalinean, la subida falla siempre con
   * "elegí un archivo" y el motivo real no aparece por ningún lado.
   *
   * Se verifica el atributo `name` y no el `FormData` que llega a la acción, y
   * no por comodidad: **jsdom no transporta el contenido de un input de archivo
   * al construir el FormData del submit**. El input queda con su archivo
   * (`input.files.length === 1`) pero la acción recibe un `File` vacío, de
   * nombre "" y tamaño 0. Un test sobre lo que llega ahí no probaría el
   * contrato: fallaría siempre, por el entorno y no por el código.
   */
  it("nombra el campo como la acción lo espera", () => {
    renderForm(null);

    expect(screen.getByLabelText(/logo/i)).toHaveAttribute("name", "logo");
  });

  // Sólo se aceptan tres formatos: el selector de archivos del sistema no
  // debería siquiera ofrecer los otros.
  it("limita el selector de archivos a los formatos aceptados", () => {
    renderForm(null);

    const input = screen.getByLabelText(/logo/i);
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
  });
});
