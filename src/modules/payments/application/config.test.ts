import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptionKey, mpClientCredentials, paymentsConfigured, stateSecret } from "./config";

let env: Record<string, string | undefined> = {};
let envThrows = false;

vi.mock("@/lib/env", () => ({
  serverEnv: () => {
    if (envThrows) throw new Error("Variables de entorno inválidas");
    return env;
  },
}));

beforeEach(() => {
  env = {};
  envThrows = false;
});

describe("config de pagos", () => {
  it("devuelve las credenciales cuando están", () => {
    env = { MERCADOPAGO_CLIENT_ID: "123", MERCADOPAGO_CLIENT_SECRET: "sec" };

    expect(mpClientCredentials()).toEqual({
      ok: true,
      value: { clientId: "123", clientSecret: "sec" },
    });
  });

  it.each([
    ["ausente", undefined],
    ["vacío", ""],
    ["en blanco", "   "],
  ])("%s es payments_not_configured", (_, value) => {
    env = {
      MERCADOPAGO_CLIENT_ID: value,
      MERCADOPAGO_CLIENT_SECRET: "sec",
      PAYMENTS_ENCRYPTION_KEY: value,
      PAYMENTS_STATE_SECRET: value,
    };

    for (const r of [mpClientCredentials(), encryptionKey(), stateSecret()]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("payments_not_configured");
    }
  });

  it("si serverEnv() tira, también es payments_not_configured y no se propaga", () => {
    envThrows = true;

    const r = encryptionKey();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("payments_not_configured");
  });
});

describe("paymentsConfigured", () => {
  const full = {
    MERCADOPAGO_CLIENT_ID: "123",
    MERCADOPAGO_CLIENT_SECRET: "sec",
    PAYMENTS_ENCRYPTION_KEY: "key",
    PAYMENTS_STATE_SECRET: "state",
  };

  it("is true only with the whole platform config", () => {
    env = full;
    expect(paymentsConfigured()).toBe(true);
  });

  it.each(Object.keys(full))("is false when %s is missing", (name) => {
    env = { ...full, [name]: undefined };
    expect(paymentsConfigured()).toBe(false);
  });
});
