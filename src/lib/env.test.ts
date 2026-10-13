import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `serverEnv()` cachea el resultado a nivel de módulo, así que cada caso
 * importa una copia nueva con el entorno ya armado.
 */
const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  BOOKING_IP_SALT: "una-sal-de-al-menos-16-caracteres",
  MERCADOPAGO_ACCESS_TOKEN: "TEST-token",
  MERCADOPAGO_WEBHOOK_SECRET: "secreto",
};
const PAYMENTS = [
  "MERCADOPAGO_CLIENT_ID",
  "MERCADOPAGO_CLIENT_SECRET",
  "PAYMENTS_ENCRYPTION_KEY",
  "PAYMENTS_STATE_SECRET",
] as const;

beforeEach(() => {
  vi.resetModules();
  for (const [k, v] of Object.entries(REQUIRED)) vi.stubEnv(k, v);
  for (const k of PAYMENTS) vi.stubEnv(k, undefined as unknown as string);
});

afterEach(() => vi.unstubAllEnvs());

describe("serverEnv: variables de pagos", () => {
  it("un deploy sin ellas sigue validando", async () => {
    const { serverEnv } = await import("./env");

    expect(() => serverEnv()).not.toThrow();
    expect(serverEnv().PAYMENTS_ENCRYPTION_KEY).toBeUndefined();
  });

  it("una línea vacía copiada de .env.example no tira la app", async () => {
    for (const k of PAYMENTS) vi.stubEnv(k, "");
    const { serverEnv } = await import("./env");

    expect(() => serverEnv()).not.toThrow();
  });

  it("las lee cuando están", async () => {
    vi.stubEnv("MERCADOPAGO_CLIENT_ID", "123");
    const { serverEnv } = await import("./env");

    expect(serverEnv().MERCADOPAGO_CLIENT_ID).toBe("123");
  });
});
