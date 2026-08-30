import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePasswordResetRedirectUrl } from "./reset-url";

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function setAppUrl(value: string | undefined) {
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
    return;
  }
  process.env.NEXT_PUBLIC_APP_URL = value;
}

afterEach(() => {
  setAppUrl(ORIGINAL_APP_URL);
  vi.restoreAllMocks();
});

describe("resolvePasswordResetRedirectUrl", () => {
  it("arma el link de recuperación con el origen configurado", () => {
    setAppUrl("https://turnos.app");

    expect(resolvePasswordResetRedirectUrl()).toBe(
      "https://turnos.app/auth/confirmar?next=%2Fnueva-contrasena",
    );
  });

  // Sin origen configurado el mail sigue saliendo, pero con un link a
  // localhost: en producción eso es una recuperación que no le sirve a nadie,
  // así que el aviso queda en el log.
  it("avisa y cae a localhost cuando NEXT_PUBLIC_APP_URL no está seteada", () => {
    setAppUrl(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolvePasswordResetRedirectUrl()).toBe(
      "http://localhost:3000/auth/confirmar?next=%2Fnueva-contrasena",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("NEXT_PUBLIC_APP_URL"),
    );
  });

  it("no avisa cuando el origen está configurado", () => {
    setAppUrl("https://turnos.app");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolvePasswordResetRedirectUrl();

    expect(warn).not.toHaveBeenCalled();
  });
});
