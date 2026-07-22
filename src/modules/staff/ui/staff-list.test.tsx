import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ActionState, errorState, idleState } from "@/core/action";
import type { CatalogService } from "@/modules/catalog/domain/types";

import type { StaffMember } from "../domain/types";
import type { StaffActions } from "./staff-actions";
import { StaffList } from "./staff-list";

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
  serviceIds: [SERVICE_A, SERVICE_B],
};

const spyAction = (result: ActionState = idleState) =>
  vi.fn<StaffActions["save"]>(async () => result);

function makeActions(overrides: Partial<StaffActions> = {}): StaffActions {
  return {
    save: spyAction(),
    toggleActive: spyAction(),
    remove: spyAction(),
    ...overrides,
  };
}

describe("StaffList", () => {
  it("shows an empty state when the business has no professionals yet", () => {
    render(
      <StaffList
        members={[]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions()}
      />,
    );

    expect(screen.getByText(/Todavía no cargaste profesionales/)).toBeInTheDocument();
  });

  it("renders name, role and the services the professional offers", () => {
    render(
      <StaffList
        members={[member]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions()}
      />,
    );

    expect(screen.getByText("Ana Gómez")).toBeInTheDocument();
    expect(screen.getByText("Peluquera")).toBeInTheDocument();
    expect(screen.getByText("Corte de pelo · Color")).toBeInTheDocument();
  });

  it("warns when a professional has no services, because nobody can book them", () => {
    render(
      <StaffList
        members={[{ ...member, serviceIds: [] }]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions()}
      />,
    );

    expect(screen.getByText(/Sin servicios asignados/)).toBeInTheDocument();
  });

  it("links each professional to their weekly schedule", () => {
    render(
      <StaffList
        members={[member]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions()}
      />,
    );

    expect(screen.getByRole("link", { name: "Horarios" })).toHaveAttribute(
      "href",
      "/panel/profesionales/st1/horarios",
    );
  });

  it("marks an inactive professional as paused and offers to reactivate", () => {
    render(
      <StaffList
        members={[{ ...member, active: false }]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions()}
      />,
    );

    expect(screen.getByText("Pausado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activar" })).toBeInTheDocument();
  });

  it("hands the whole professional to onEdit when editing a row", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <StaffList
        members={[member]}
        services={services}
        onEdit={onEdit}
        actions={makeActions()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(onEdit).toHaveBeenCalledWith(member);
  });

  it("submits the professional id when pausing a row", async () => {
    const toggleActive = spyAction();
    const user = userEvent.setup();
    render(
      <StaffList
        members={[member]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions({ toggleActive })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Pausar" }));

    expect(toggleActive.mock.calls[0][1].get("id")).toBe("st1");
  });

  it("surfaces the error when a professional cannot be deleted", async () => {
    const remove = spyAction(
      errorState("Ana Gómez ya tiene turnos, así que no se puede eliminar."),
    );
    const user = userEvent.setup();
    render(
      <StaffList
        members={[member]}
        services={services}
        onEdit={vi.fn()}
        actions={makeActions({ remove })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    expect(
      await screen.findByText(/ya tiene turnos, así que no se puede eliminar/),
    ).toBeInTheDocument();
  });
});
