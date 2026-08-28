import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePublicBookingUrl } from "./public-url";

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

describe("resolvePublicBookingUrl", () => {
  it("arma la URL pública con el origen configurado", () => {
    setAppUrl("https://turnos.app");

    expect(resolvePublicBookingUrl("acme")).toBe("https://turnos.app/acme");
  });

  it("ignora la barra final del origen configurado", () => {
    setAppUrl("https://turnos.app/");

    expect(resolvePublicBookingUrl("acme")).toBe("https://turnos.app/acme");
  });

  // Sin origen configurado el link igual tiene que servir en desarrollo, pero
  // el aviso queda en el log: en producción ese fallback es un link roto.
  it("avisa y cae a localhost cuando NEXT_PUBLIC_APP_URL no está seteada", () => {
    setAppUrl(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolvePublicBookingUrl("acme")).toBe("http://localhost:3000/acme");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("NEXT_PUBLIC_APP_URL"),
    );
  });

  it("no avisa cuando el origen está configurado", () => {
    setAppUrl("https://turnos.app");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolvePublicBookingUrl("acme");

    expect(warn).not.toHaveBeenCalled();
  });
});
