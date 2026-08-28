import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import type { ScheduleWindow } from "../domain/schedule";
import type { StaffActions } from "./staff-actions";
import { ScheduleEditor } from "./schedule-editor";

const monday: ScheduleWindow = {
  weekday: 1,
  startTime: "09:00",
  endTime: "13:00",
};

const spySave = (result: ActionState = idleState) =>
  vi.fn<StaffActions["save"]>(async () => result);

/** El bloque de un día, para no confundir franjas entre días distintos. */
const dayBlock = (label: string) =>
  within(screen.getByRole("group", { name: label }));

describe("ScheduleEditor", () => {
  it("marks a weekday with no windows as closed", () => {
    render(<ScheduleEditor staffId="st1" windows={[]} save={spySave()} />);

    expect(dayBlock("Lunes").getByText("Cerrado")).toBeInTheDocument();
    expect(dayBlock("Domingo").getByText("Cerrado")).toBeInTheDocument();
  });

  it("renders an existing window on its own weekday", () => {
    render(<ScheduleEditor staffId="st1" windows={[monday]} save={spySave()} />);

    expect(dayBlock("Lunes").getByLabelText("Desde")).toHaveValue("09:00");
    expect(dayBlock("Lunes").getByLabelText("Hasta")).toHaveValue("13:00");
    expect(dayBlock("Martes").getByText("Cerrado")).toBeInTheDocument();
  });

  it("adds a window to the weekday the owner picked", async () => {
    const user = userEvent.setup();
    render(<ScheduleEditor staffId="st1" windows={[]} save={spySave()} />);

    await user.click(
      screen.getByRole("button", { name: "Agregar franja el Miércoles" }),
    );

    expect(dayBlock("Miércoles").getByLabelText("Desde")).toBeInTheDocument();
    expect(dayBlock("Miércoles").queryByText("Cerrado")).not.toBeInTheDocument();
  });

  it("removes a window and closes the weekday again", async () => {
    const user = userEvent.setup();
    render(<ScheduleEditor staffId="st1" windows={[monday]} save={spySave()} />);

    await user.click(dayBlock("Lunes").getByRole("button", { name: "Quitar franja" }));

    expect(dayBlock("Lunes").getByText("Cerrado")).toBeInTheDocument();
  });

  it("keeps the typed times of the other rows when one is removed", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleEditor
        staffId="st1"
        windows={[monday, { weekday: 1, startTime: "15:00", endTime: "19:00" }]}
        save={spySave()}
      />,
    );

    const [firstRemove] = dayBlock("Lunes").getAllByRole("button", {
      name: "Quitar franja",
    });
    await user.click(firstRemove);

    expect(dayBlock("Lunes").getByLabelText("Desde")).toHaveValue("15:00");
  });

  it("submits every window along with its weekday", async () => {
    const save = spySave();
    const user = userEvent.setup();
    render(<ScheduleEditor staffId="st1" windows={[monday]} save={save} />);

    await user.click(
      screen.getByRole("button", { name: "Agregar franja el Sábado" }),
    );
    await user.click(screen.getByRole("button", { name: "Guardar horario" }));

    const formData = save.mock.calls[0][1];
    expect(formData.get("staffId")).toBe("st1");
    // El sábado es 6 en extract(dow), y va después del lunes en la lectura.
    expect(formData.getAll("weekday")).toEqual(["1", "6"]);
    expect(formData.getAll("startTime")[0]).toBe("09:00");
    expect(formData.getAll("endTime")[0]).toBe("13:00");
  });

  it("submits an empty week when every weekday is closed", async () => {
    const save = spySave();
    const user = userEvent.setup();
    render(<ScheduleEditor staffId="st1" windows={[]} save={save} />);

    await user.click(screen.getByRole("button", { name: "Guardar horario" }));

    expect(save.mock.calls[0][1].getAll("weekday")).toEqual([]);
  });

  it("shows the error returned by the action", async () => {
    const save = spySave(errorState("Hay franjas que se pisan en el mismo día."));
    const user = userEvent.setup();
    render(<ScheduleEditor staffId="st1" windows={[monday]} save={save} />);

    await user.click(screen.getByRole("button", { name: "Guardar horario" }));

    expect(
      await screen.findByText("Hay franjas que se pisan en el mismo día."),
    ).toBeInTheDocument();
  });

  it("confirms when the schedule was saved", async () => {
    const save = spySave({ status: "success", message: "Horario guardado." });
    const user = userEvent.setup();
    render(<ScheduleEditor staffId="st1" windows={[monday]} save={save} />);

    await user.click(screen.getByRole("button", { name: "Guardar horario" }));

    expect(await screen.findByText("Horario guardado.")).toBeInTheDocument();
  });

  /**
   * Después de guardar, React 19 resetea el form y `revalidatePath` vuelve a
   * renderizar la página con lo que quedó en la base. El `rerender` con las
   * franjas guardadas es esa segunda pasada: lo que se ve tiene que ser lo
   * que se guardó, no el horario con el que se abrió la pantalla.
   */
  describe("after a successful save", () => {
    const savedSave = () =>
      spySave({ status: "success", message: "Horario guardado." });

    it("keeps the edited times on screen", async () => {
      const save = savedSave();
      const user = userEvent.setup();
      const { rerender } = render(
        <ScheduleEditor staffId="st1" windows={[monday]} save={save} />,
      );

      await user.clear(dayBlock("Lunes").getByLabelText("Desde"));
      await user.type(dayBlock("Lunes").getByLabelText("Desde"), "10:00");
      await user.clear(dayBlock("Lunes").getByLabelText("Hasta"));
      await user.type(dayBlock("Lunes").getByLabelText("Hasta"), "14:00");
      await user.click(screen.getByRole("button", { name: "Guardar horario" }));

      rerender(
        <ScheduleEditor
          staffId="st1"
          windows={[{ weekday: 1, startTime: "10:00", endTime: "14:00" }]}
          save={save}
        />,
      );

      expect(dayBlock("Lunes").getByLabelText("Desde")).toHaveValue("10:00");
      expect(dayBlock("Lunes").getByLabelText("Hasta")).toHaveValue("14:00");
    });

    it("keeps the times typed into a window added with the button", async () => {
      const save = savedSave();
      const user = userEvent.setup();
      const added: ScheduleWindow = {
        weekday: 3,
        startTime: "15:00",
        endTime: "19:00",
      };
      const { rerender } = render(
        <ScheduleEditor staffId="st1" windows={[]} save={save} />,
      );

      await user.click(
        screen.getByRole("button", { name: "Agregar franja el Miércoles" }),
      );
      await user.clear(dayBlock("Miércoles").getByLabelText("Desde"));
      await user.type(
        dayBlock("Miércoles").getByLabelText("Desde"),
        added.startTime,
      );
      await user.clear(dayBlock("Miércoles").getByLabelText("Hasta"));
      await user.type(
        dayBlock("Miércoles").getByLabelText("Hasta"),
        added.endTime,
      );
      await user.click(screen.getByRole("button", { name: "Guardar horario" }));

      rerender(<ScheduleEditor staffId="st1" windows={[added]} save={save} />);

      expect(dayBlock("Miércoles").getByLabelText("Desde")).toHaveValue("15:00");
      expect(dayBlock("Miércoles").getByLabelText("Hasta")).toHaveValue("19:00");
    });

    it("does not bring back a removed window", async () => {
      const save = savedSave();
      const user = userEvent.setup();
      const { rerender } = render(
        <ScheduleEditor staffId="st1" windows={[monday]} save={save} />,
      );

      await user.click(
        dayBlock("Lunes").getByRole("button", { name: "Quitar franja" }),
      );
      await user.click(screen.getByRole("button", { name: "Guardar horario" }));

      rerender(<ScheduleEditor staffId="st1" windows={[]} save={save} />);

      expect(dayBlock("Lunes").getByText("Cerrado")).toBeInTheDocument();
    });
  });
});
