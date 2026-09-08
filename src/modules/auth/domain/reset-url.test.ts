import { describe, expect, it } from "vitest";

import { passwordResetRedirectUrl } from "./reset-url";

/**
 * La URL que viaja en `redirectTo` y que Supabase pega en el mail.
 *
 * Es pura a propósito: recibe el origen en vez de leerlo del entorno, así se
 * testea sin tocar `process.env` (mismo corte que `domain/public-url.ts`).
 */

describe("passwordResetRedirectUrl", () => {
  it("apunta al route handler que canjea el token, con el destino en `next`", () => {
    expect(passwordResetRedirectUrl("https://turnos.app")).toBe(
      "https://turnos.app/auth/confirmar?next=%2Fnueva-contrasena",
    );
  });

  it("ignora la barra final del origen para no armar una URL con doble barra", () => {
    expect(passwordResetRedirectUrl("https://turnos.app/")).toBe(
      "https://turnos.app/auth/confirmar?next=%2Fnueva-contrasena",
    );
  });
});
