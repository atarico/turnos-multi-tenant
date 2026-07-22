import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";
import type { CatalogService } from "@/modules/catalog/domain/types";

import type { StaffMember } from "../domain/types";
import type { StaffActions } from "./staff-actions";
import { StaffForm } from "./staff-form";

const SERVICE_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_B = "22222222-2222-4222-8222-222222222222";

const services: CatalogService[] = [
  {
    id: SERVICE_A,
    name: "Corte de pelo",
    description: null,
    durationMin: 45,
    priceCents: 150000,
    currency: "ARS",
    capacity: 1,
    active: true,
  },
  {
    id: SERVICE_B,
    name: "Color",
    description: null,
    durationMin: 90,
    priceCents: 400000,
    currency: "ARS",
    capacity: 1,
    active: true,
  },
];

const member: StaffMember = {
  id: "st1",
  name: "Ana Gómez",
  role: "Peluquera",
  active: true,
  serviceIds: [SERVICE_A],
};

const spySave = (result: ActionState = idleState) =>
  vi.fn<StaffActions["save"]>(async () => result);

describe("StaffForm", () => {
  it("starts empty when creating a professional", () => {
    render(
      <StaffForm
        member={null}
        services={services}
        save={spySave()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Nombre")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Agregar profesional" }),
    ).toBeInTheDocument();
  });

  it("prefills the fields and checks only the assigned services", () => {
    render(
      <StaffForm
        member={member}
        services={services}
        save={spySave()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana Gómez");
    expect(screen.getByLabelText("Especialidad")).toHaveValue("Peluquera");
    expect(screen.getByRole("checkbox", { name: "Corte de pelo" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Color" })).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Guardar cambios" }),
    ).toBeInTheDocument();
  });

  it("sends the name and every checked service to the save action", async () => {
    const save = spySave();
    const user = userEvent.setup();
    render(
      <StaffForm
        member={null}
        services={services}
        save={save}
        onCancel={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Nombre"), "Juan Pérez");
    await user.click(screen.getByRole("checkbox", { name: "Color" }));
    await user.click(screen.getByRole("button", { name: "Agregar profesional" }));

    const formData = save.mock.calls[0][1];
    expect(formData.get("name")).toBe("Juan Pérez");
    expect(formData.getAll("serviceIds")).toEqual([SERVICE_B]);
    expect(formData.get("id")).toBe("");
  });

  it("carries the id when editing so the action updates instead of creating", async () => {
    const save = spySave();
    const user = userEvent.setup();
    render(
      <StaffForm
        member={member}
        services={services}
        save={save}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(save.mock.calls[0][1].get("id")).toBe("st1");
  });

  it("tells the owner to create a service first when the catalog is empty", () => {
    render(
      <StaffForm member={null} services={[]} save={spySave()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText(/Creá un servicio primero/)).toBeInTheDocument();
  });

  it("shows the general message and the per-field errors returned by the action", async () => {
    const save = spySave(
      errorState("Revisá los datos del profesional.", {
        name: "El nombre es muy corto",
      }),
    );
    const user = userEvent.setup();
    render(
      <StaffForm
        member={null}
        services={services}
        save={save}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Agregar profesional" }));

    expect(
      await screen.findByText("Revisá los datos del profesional."),
    ).toBeInTheDocument();
    expect(screen.getByText("El nombre es muy corto")).toBeInTheDocument();
  });

  it("lets the user drop out of edit mode", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <StaffForm
        member={member}
        services={services}
        save={spySave()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
