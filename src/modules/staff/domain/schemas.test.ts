import { describe, expect, it } from "vitest";

import { staffFormSchema } from "./schemas";

const SERVICE_A = "11111111-1111-4111-8111-111111111111";
const SERVICE_B = "22222222-2222-4222-8222-222222222222";

const validInput = {
  name: "Ana Gómez",
  role: "Peluquera",
  serviceIds: [SERVICE_A, SERVICE_B],
};

function fieldError(
  input: { name: string; role: string; serviceIds: string[] },
  field: string,
) {
  const result = staffFormSchema.safeParse(input);
  if (result.success) return undefined;
  return result.error.issues.find((i) => i.path[0] === field)?.message;
}

describe("staffFormSchema", () => {
  it("parses a valid form", () => {
    const result = staffFormSchema.safeParse(validInput);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      name: "Ana Gómez",
      role: "Peluquera",
      serviceIds: [SERVICE_A, SERVICE_B],
    });
  });

  it("trims the name and turns an empty role into null", () => {
    const result = staffFormSchema.safeParse({
      ...validInput,
      name: "  Ana  ",
      role: "   ",
    });

    expect(result.success && result.data.name).toBe("Ana");
    expect(result.success && result.data.role).toBeNull();
  });

  it("accepts a professional with no services assigned yet", () => {
    const result = staffFormSchema.safeParse({ ...validInput, serviceIds: [] });

    expect(result.success && result.data.serviceIds).toEqual([]);
  });

  it("drops duplicated service ids", () => {
    const result = staffFormSchema.safeParse({
      ...validInput,
      serviceIds: [SERVICE_A, SERVICE_A],
    });

    expect(result.success && result.data.serviceIds).toEqual([SERVICE_A]);
  });

  it("rejects a name shorter than two characters", () => {
    expect(fieldError({ ...validInput, name: "A" }, "name")).toBeTruthy();
  });

  it("rejects a service id that is not a uuid", () => {
    expect(
      fieldError({ ...validInput, serviceIds: ["not-a-uuid"] }, "serviceIds"),
    ).toBeTruthy();
  });
});
