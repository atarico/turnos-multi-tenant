import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import type { CatalogService } from "../domain/types";
import type { ServiceActions } from "./service-actions";
import { ServicesManager } from "./services-manager";

const service: CatalogService = {
  id: "s1",
  name: "Corte de pelo",
  description: null,
  durationMin: 45,
  priceCents: 150050,
  currency: "ARS",
  capacity: 1,
  active: true,
};

const noop = () => vi.fn<ServiceActions["save"]>(async () => idleState);

const actions: ServiceActions = {
  save: noop(),
  toggleActive: noop(),
  remove: noop(),
};

describe("ServicesManager", () => {
  it("starts on the create form", () => {
    render(<ServicesManager services={[service]} actions={actions} />);

    expect(screen.getByRole("heading", { name: "Nuevo servicio" })).toBeInTheDocument();
  });

  it("loads the picked service into the form when editing", async () => {
    const user = userEvent.setup();
    render(<ServicesManager services={[service]} actions={actions} />);

    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(screen.getByRole("heading", { name: "Editar servicio" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre")).toHaveValue("Corte de pelo");
  });

  it("goes back to the create form when the edit is cancelled", async () => {
    const user = userEvent.setup();
    render(<ServicesManager services={[service]} actions={actions} />);

    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.getByRole("heading", { name: "Nuevo servicio" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre")).toHaveValue("");
  });
});
