import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";

import type { CatalogService } from "../domain/types";
import type { ServiceActions } from "./service-actions";
import { ServiceList } from "./service-list";

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

/** Espía con la firma exacta de una Server Action de formulario. */
const spyAction = (result: ActionState = idleState) =>
  vi.fn<ServiceActions["save"]>(async () => result);

function makeActions(overrides: Partial<ServiceActions> = {}): ServiceActions {
  return {
    save: spyAction(),
    toggleActive: spyAction(),
    remove: spyAction(),
    ...overrides,
  };
}

describe("ServiceList", () => {
  it("shows an empty state when the business has no services yet", () => {
    render(<ServiceList services={[]} onEdit={vi.fn()} actions={makeActions()} />);

    expect(screen.getByText(/Todavía no cargaste servicios/)).toBeInTheDocument();
  });

  it("renders name, description, duration, price and capacity", () => {
    render(
      <ServiceList services={[service]} onEdit={vi.fn()} actions={makeActions()} />,
    );

    expect(screen.getByText("Corte de pelo")).toBeInTheDocument();
    expect(screen.getByText("Lavado, corte y peinado")).toBeInTheDocument();
    expect(screen.getByText(/45 min/)).toBeInTheDocument();
    expect(screen.getByText(/\$ 1\.500,50/)).toBeInTheDocument();
    expect(screen.getByText(/cupo 2/)).toBeInTheDocument();
  });

  it("marks an inactive service as paused and offers to reactivate it", () => {
    render(
      <ServiceList
        services={[{ ...service, active: false }]}
        onEdit={vi.fn()}
        actions={makeActions()}
      />,
    );

    expect(screen.getByText("Pausado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activar" })).toBeInTheDocument();
  });

  it("hands the whole service to onEdit when editing a row", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <ServiceList services={[service]} onEdit={onEdit} actions={makeActions()} />,
    );

    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(onEdit).toHaveBeenCalledWith(service);
  });

  it("submits the service id when pausing a row", async () => {
    const toggleActive = spyAction();
    const user = userEvent.setup();
    render(
      <ServiceList
        services={[service]}
        onEdit={vi.fn()}
        actions={makeActions({ toggleActive })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pausar" }));

    expect(toggleActive).toHaveBeenCalledOnce();
    const formData = toggleActive.mock.calls[0][1] as FormData;
    expect(formData.get("id")).toBe("s1");
  });

  it("surfaces the error when a service cannot be deleted", async () => {
    const remove = spyAction(
      errorState("No podés eliminar un servicio con turnos."),
    );
    const user = userEvent.setup();
    render(
      <ServiceList
        services={[service]}
        onEdit={vi.fn()}
        actions={makeActions({ remove })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    expect(
      await screen.findByText("No podés eliminar un servicio con turnos."),
    ).toBeInTheDocument();
  });
});
