import { describe, expect, it } from "vitest";

import { serviceFormSchema } from "./schemas";

const validInput = {
  name: "Corte de pelo",
  description: "Lavado, corte y peinado",
  durationMin: "45",
  price: "1.500,50",
  capacity: "1",
};

/** First error message for a given field, or undefined when the field is valid. */
function fieldError(input: Record<string, string>, field: string) {
  const result = serviceFormSchema.safeParse(input);
  if (result.success) return undefined;
  return result.error.issues.find((i) => i.path[0] === field)?.message;
}

describe("serviceFormSchema", () => {
  it("parses a valid form into domain values", () => {
    const result = serviceFormSchema.safeParse(validInput);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      name: "Corte de pelo",
      description: "Lavado, corte y peinado",
      durationMin: 45,
      priceCents: 150050,
      capacity: 1,
    });
  });

  it("trims the name and turns an empty description into null", () => {
    const result = serviceFormSchema.safeParse({
      ...validInput,
      name: "  Corte  ",
      description: "   ",
    });

    expect(result.success && result.data.name).toBe("Corte");
    expect(result.success && result.data.description).toBeNull();
  });

  it("rejects a name shorter than two characters", () => {
    expect(fieldError({ ...validInput, name: "A" }, "name")).toBeTruthy();
  });

  it("rejects a duration that is not a positive whole number", () => {
    expect(fieldError({ ...validInput, durationMin: "0" }, "durationMin")).toBeTruthy();
    expect(fieldError({ ...validInput, durationMin: "45.5" }, "durationMin")).toBeTruthy();
    expect(fieldError({ ...validInput, durationMin: "" }, "durationMin")).toBeTruthy();
  });

  it("rejects a duration longer than a full day", () => {
    expect(fieldError({ ...validInput, durationMin: "1441" }, "durationMin")).toBeTruthy();
  });

  it("rejects a capacity below one", () => {
    expect(fieldError({ ...validInput, capacity: "0" }, "capacity")).toBeTruthy();
  });

  it("rejects a price that is not a valid amount", () => {
    expect(fieldError({ ...validInput, price: "gratis" }, "price")).toBeTruthy();
  });

  it("accepts a free service", () => {
    const result = serviceFormSchema.safeParse({ ...validInput, price: "0" });

    expect(result.success && result.data.priceCents).toBe(0);
  });
});
