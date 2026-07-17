import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodFieldErrors } from "./action";

const schema = z.object({
  name: z.string().min(2, "Ingresá el nombre"),
  email: z.email("Email inválido"),
});

function errorFor(input: unknown): z.ZodError {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("se esperaba un error de validación");
  return parsed.error;
}

describe("zodFieldErrors", () => {
  it("maps each issue to its field", () => {
    expect(zodFieldErrors(errorFor({ name: "a", email: "nope" }))).toEqual({
      name: "Ingresá el nombre",
      email: "Email inválido",
    });
  });

  it("keeps the first message when a field has several issues", () => {
    const error = new z.ZodError([
      { code: "custom", path: ["name"], message: "primero" },
      { code: "custom", path: ["name"], message: "segundo" },
    ]);

    expect(zodFieldErrors(error)).toEqual({ name: "primero" });
  });

  it("ignores issues whose path is not a field name", () => {
    const error = new z.ZodError([
      { code: "custom", path: [], message: "error de raíz" },
      { code: "custom", path: [0], message: "índice de array" },
    ]);

    expect(zodFieldErrors(error)).toEqual({});
  });
});
