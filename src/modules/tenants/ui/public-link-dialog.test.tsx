import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_LINK_DIALOG_DISMISSED_KEY,
  PublicLinkDialog,
} from "./public-link-dialog";

const URL = "https://turnos.app/acme";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PublicLinkDialog", () => {
  it("renders nothing when not triggered", () => {
    render(<PublicLinkDialog url={URL} triggered={false} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the dialog when triggered and storage has no opt-out", async () => {
    render(<PublicLinkDialog url={URL} triggered={true} />);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("stays closed when the browser already opted out", () => {
    localStorage.setItem(PUBLIC_LINK_DIALOG_DISMISSED_KEY, "true");

    render(<PublicLinkDialog url={URL} triggered={true} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("copies the exact URL to the clipboard", async () => {
    const user = userEvent.setup();
    render(<PublicLinkDialog url={URL} triggered={true} />);
    await screen.findByRole("dialog");
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));

    expect(writeText).toHaveBeenCalledWith(URL);
  });

  it("degrades silently when the clipboard write is rejected", async () => {
    const user = userEvent.setup();
    render(<PublicLinkDialog url={URL} triggered={true} />);
    await screen.findByRole("dialog");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("clipboard denied"),
    );

    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));

    expect(
      screen.getByRole("button", { name: "Copiar enlace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copiado" }),
    ).not.toBeInTheDocument();
  });

  it("persists the opt-out when the checkbox is checked before dismissing", async () => {
    const user = userEvent.setup();
    render(<PublicLinkDialog url={URL} triggered={true} />);
    await screen.findByRole("dialog");

    await user.click(
      screen.getByRole("checkbox", { name: "No volver a mostrar" }),
    );
    await user.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(localStorage.getItem(PUBLIC_LINK_DIALOG_DISMISSED_KEY)).toBe(
      "true",
    );
  });

  it("leaves storage untouched when dismissed without checking the box", async () => {
    const user = userEvent.setup();
    render(<PublicLinkDialog url={URL} triggered={true} />);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(localStorage.getItem(PUBLIC_LINK_DIALOG_DISMISSED_KEY)).toBeNull();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<PublicLinkDialog url={URL} triggered={true} />);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still renders when reading storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    render(<PublicLinkDialog url={URL} triggered={true} />);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
