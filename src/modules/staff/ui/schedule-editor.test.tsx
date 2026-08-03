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
});
