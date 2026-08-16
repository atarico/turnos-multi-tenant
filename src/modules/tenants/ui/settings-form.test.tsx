import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import { SettingsForm } from "./settings-form";

const spySave = (result: ActionState = idleState) =>
  vi.fn(async () => result) as unknown as (
    prev: ActionState,
    formData: FormData,
  ) => Promise<ActionState>;

const colorInput = () => screen.getByLabelText("Color de marca");
const fileInput = () => screen.getByLabelText(/^logo$/i);
const saveButton = () => screen.getByRole("button", { name: /guardar/i });

const pickFile = (name = "nuevo.png") => {
  const file = new File([new Uint8Array(8)], name, { type: "image/png" });
  fireEvent.change(fileInput(), { target: { files: [file] } });
  return file;
};

beforeEach(() => {
  // jsdom no implementa createObjectURL, y la vista previa depende de él.
  URL.createObjectURL = vi.fn(() => "blob:vista-previa");
  URL.revokeObjectURL = vi.fn();
});

describe("SettingsForm", () => {
  /**
   * Lo que pidió el usuario, y la razón de que color y logo vivan en el mismo
   * formulario: UN botón que guarda todo. Si aparecieran dos, volveríamos a la
   * pantalla anterior donde cada cosa se guardaba por su lado.
   */
  it("tiene un solo botón de guardado", () => {
    render(
      <SettingsForm brandColor="#aabbcc" logoUrl={null} save={spySave()} />,
    );

    expect(screen.getAllByRole("button", { name: /guardar/i })).toHaveLength(1);
  });

  it("arranca con el color y el logo que el negocio tiene guardados", () => {
    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl="https://cdn.test/logo.png"
        save={spySave()}
      />,
    );

    expect(colorInput()).toHaveValue("#aabbcc");
    expect(screen.getByRole("img", { name: /logo/i })).toHaveAttribute(
      "src",
      "https://cdn.test/logo.png",
    );
  });

  /**
   * La vista previa que pidió el usuario: al elegir un archivo se ve ESE
   * archivo, no el que está guardado. Sin esto hay que guardar para descubrir
   * si elegiste el archivo correcto.
   */
  it("muestra la vista previa del archivo recién elegido", () => {
    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl="https://cdn.test/viejo.png"
        save={spySave()}
      />,
    );

    pickFile();

    expect(screen.getByRole("img", { name: /logo/i })).toHaveAttribute(
      "src",
      "blob:vista-previa",
    );
  });

  it("muestra la vista previa aunque no hubiera logo antes", () => {
    render(
      <SettingsForm brandColor="#aabbcc" logoUrl={null} save={spySave()} />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    pickFile();

    expect(screen.getByRole("img", { name: /logo/i })).toHaveAttribute(
      "src",
      "blob:vista-previa",
    );
  });

  // Elegir un archivo por error no debería obligar a recargar la página.
  it("permite deshacer la elección y vuelve a mostrar el logo guardado", async () => {
    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl="https://cdn.test/viejo.png"
        save={spySave()}
      />,
    );

    pickFile();
    await userEvent.click(screen.getByRole("button", { name: /deshacer/i }));

    expect(screen.getByRole("img", { name: /logo/i })).toHaveAttribute(
      "src",
      "https://cdn.test/viejo.png",
    );
  });

  /**
   * La casilla de sacar el logo no tiene sentido sin logo que sacar, ni con un
   * archivo nuevo elegido: en ese caso el archivo ya es la intención del
   * usuario y la casilla diría lo contrario.
   */
  it("ofrece sacar el logo sólo cuando hay uno y no se eligió archivo", () => {
    const { unmount } = render(
      <SettingsForm brandColor="#aabbcc" logoUrl={null} save={spySave()} />,
    );
    expect(screen.queryByLabelText(/sacar/i)).not.toBeInTheDocument();
    unmount();

    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl="https://cdn.test/viejo.png"
        save={spySave()}
      />,
    );
    expect(screen.getByLabelText(/sacar/i)).toBeInTheDocument();

    pickFile();
    expect(screen.queryByLabelText(/sacar/i)).not.toBeInTheDocument();
  });

  it("muestra el error del color pegado a su campo", async () => {
    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl={null}
        save={spySave(
          errorState("Revisá los datos del formulario.", {
            brandColor: "Elegí un color válido.",
          }),
        )}
      />,
    );

    await userEvent.click(saveButton());

    expect(
      await screen.findByText("Elegí un color válido."),
    ).toBeInTheDocument();
  });

  it("muestra el error del logo pegado a su campo", async () => {
    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl={null}
        save={spySave(
          errorState("Sólo aceptamos PNG, JPG o WEBP.", {
            logo: "Sólo aceptamos PNG, JPG o WEBP.",
          }),
        )}
      />,
    );

    await userEvent.click(saveButton());

    expect(
      await screen.findByText("Sólo aceptamos PNG, JPG o WEBP."),
    ).toBeInTheDocument();
  });

  // El color es lo único que se ve cambiar sin guardar, así que su cartel de
  // éxito se baja en cuanto deja de coincidir con lo que el servidor devolvió.
  it("baja el cartel de éxito cuando el usuario vuelve a tocar el color", async () => {
    render(
      <SettingsForm
        brandColor="#aabbcc"
        logoUrl={null}
        save={spySave({ status: "success", message: "Listo, guardamos los cambios." })}
      />,
    );

    await userEvent.click(saveButton());
    expect(
      await screen.findByText("Listo, guardamos los cambios."),
    ).toBeInTheDocument();

    fireEvent.change(colorInput(), { target: { value: "#00ff00" } });

    expect(
      screen.queryByText("Listo, guardamos los cambios."),
    ).not.toBeInTheDocument();
  });

  it("limita el selector de archivos a los formatos aceptados", () => {
    render(
      <SettingsForm brandColor="#aabbcc" logoUrl={null} save={spySave()} />,
    );

    expect(fileInput()).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp",
    );
  });
});
