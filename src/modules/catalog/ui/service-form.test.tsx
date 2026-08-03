import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import type { CatalogService } from "../domain/types";
import type { ServiceActions } from "./service-actions";
import { ServiceForm } from "./service-form";

const service: CatalogService = {
  id: "s1",
  name: "Corte de pelo",
  description: "Lavado, corte y peinado",
  durationMin: 45,
  priceCents: 150050,
  currency: "ARS",
  capacity: 2,
  active: true,
};

const spySave = (result: ActionState = idleState) =>
  vi.fn<ServiceActions["save"]>(async () => result);

describe("ServiceForm", () => {
  it("starts empty when creating a service", () => {
    render(<ServiceForm service={null} save={spySave()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText("Nombre")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Crear servicio" })).toBeInTheDocument();
  });

  it("prefills every field when editing a service", () => {
    render(<ServiceForm service={service} save={spySave()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText("Nombre")).toHaveValue("Corte de pelo");
    expect(screen.getByLabelText("Descripción")).toHaveValue("Lavado, corte y peinado");
    expect(screen.getByLabelText("Duración (minutos)")).toHaveValue("45");
    // El precio vuelve al input como monto editable, no como texto con símbolo.
    expect(screen.getByLabelText("Precio")).toHaveValue("1500,50");
    expect(screen.getByLabelText("Cupo por turno")).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeInTheDocument();
  });

  it("sends the typed values to the save action", async () => {
    const save = spySave();
    const user = userEvent.setup();
    render(<ServiceForm service={null} save={save} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText("Nombre"), "Manicura");
    await user.type(screen.getByLabelText("Duración (minutos)"), "30");
    await user.type(screen.getByLabelText("Precio"), "800");
    await user.click(screen.getByRole("button", { name: "Crear servicio" }));

    expect(save).toHaveBeenCalledOnce();
    const formData = save.mock.calls[0][1];
    expect(formData.get("name")).toBe("Manicura");
    expect(formData.get("durationMin")).toBe("30");
    expect(formData.get("price")).toBe("800");
    // Sin id, la action sabe que es un alta.
    expect(formData.get("id")).toBe("");
  });

  it("carries the id when editing so the action updates instead of creating", async () => {
    const save = spySave();
    const user = userEvent.setup();
    render(<ServiceForm service={service} save={save} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(save.mock.calls[0][1].get("id")).toBe("s1");
  });

  it("shows the general message and the per-field errors returned by the action", async () => {
    const save = spySave(
      errorState("Revisá los datos del servicio.", { name: "El nombre es muy corto" }),
    );
    const user = userEvent.setup();
    render(<ServiceForm service={null} save={save} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Crear servicio" }));

    expect(await screen.findByText("Revisá los datos del servicio.")).toBeInTheDocument();
    expect(screen.getByText("El nombre es muy corto")).toBeInTheDocument();
  });

  it("lets the user drop out of edit mode", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ServiceForm service={service} save={spySave()} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
