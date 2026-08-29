import { describe, expect, it } from "vitest";

import { newPasswordSchema, recoverSchema } from "./schemas";

/**
 * Los dos esquemas de la recuperación de contraseña.
 *
 * El de la clave nueva es el que importa: quien llega acá NO tiene la
 * contraseña vieja para comparar, así que el único control contra el typo es
 * la confirmación. Y el error tiene que caer en el campo de confirmación, no
 * en el de la contraseña, porque `zodFieldErrors` pinta el mensaje debajo del
 * input que nombra el `path` — culpar al primero manda a corregir el campo
 * equivocado.
 */

describe("recoverSchema", () => {
  it("acepta un email válido", () => {
    const parsed = recoverSchema.safeParse({ email: "martina@negocio.com" });

    expect(parsed.success).toBe(true);
  });

  it("rechaza un email inválido", () => {
    const parsed = recoverSchema.safeParse({ email: "no-es-un-email" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Email inválido");
  });
});

describe("newPasswordSchema", () => {
  it("acepta dos contraseñas iguales de 8 caracteres o más", () => {
    const parsed = newPasswordSchema.safeParse({
      password: "claveNueva1",
      passwordConfirm: "claveNueva1",
    });

    expect(parsed.success).toBe(true);
  });

  it("rechaza una contraseña corta", () => {
    const parsed = newPasswordSchema.safeParse({
      password: "corta",
      passwordConfirm: "corta",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "La contraseña necesita al menos 8 caracteres",
    );
  });

  it("rechaza cuando la confirmación no coincide y culpa al campo de confirmación", () => {
    const parsed = newPasswordSchema.safeParse({
      password: "claveNueva1",
      passwordConfirm: "claveNueva2",
    });

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues[0];
    expect(issue?.path).toEqual(["passwordConfirm"]);
    expect(issue?.message).toBe("Las contraseñas no coinciden");
  });
});
