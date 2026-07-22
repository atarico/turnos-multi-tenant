import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import type { CatalogService } from "@/modules/catalog/domain/types";

import type { StaffMember } from "../domain/types";
import type { StaffActions } from "./staff-actions";
import { StaffManager } from "./staff-manager";

const SERVICE_A = "11111111-1111-4111-8111-111111111111";

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
];

const member: StaffMember = {
  id: "st1",
  name: "Ana Gómez",
  role: "Peluquera",
  active: true,
  serviceIds: [SERVICE_A],
};

const noop = () => vi.fn<StaffActions["save"]>(async () => idleState);

const actions: StaffActions = {
  save: noop(),
  toggleActive: noop(),
  remove: noop(),
};

describe("StaffManager", () => {
  it("starts on the create form", () => {
    render(
      <StaffManager members={[member]} services={services} actions={actions} />,
    );

    expect(
      screen.getByRole("heading", { name: "Nuevo profesional" }),
    ).toBeInTheDocument();
  });

  it("loads the picked professional into the form when editing", async () => {
    const user = userEvent.setup();
    render(
      <StaffManager members={[member]} services={services} actions={actions} />,
    );

    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(
      screen.getByRole("heading", { name: "Editar profesional" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana Gómez");
    expect(screen.getByRole("checkbox", { name: "Corte de pelo" })).toBeChecked();
  });

  it("goes back to the create form when the edit is cancelled", async () => {
    const user = userEvent.setup();
    render(
      <StaffManager members={[member]} services={services} actions={actions} />,
    );

    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(
      screen.getByRole("heading", { name: "Nuevo profesional" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre")).toHaveValue("");
    expect(
      screen.getByRole("checkbox", { name: "Corte de pelo" }),
    ).not.toBeChecked();
  });
});
