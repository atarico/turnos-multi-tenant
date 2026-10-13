import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyState } from "@/modules/payments/domain/oauth";
import { openConnectCookie } from "@/modules/payments/domain/connect-cookie";

const KEY = randomBytes(32).toString("base64");
const SECRET = "secreto-de-state-largo";
let env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

let owner: unknown = { ok: true, value: { tenantId: "t1" } };
vi.mock("@/modules/payments/application/ownership", () => ({
  currentOwnerTenant: async () => owner,
}));

const { GET } = await import("./route");

const call = () => GET();

beforeEach(() => {
  env = {
    NEXT_PUBLIC_APP_URL: "https://app.turnos.com",
    MERCADOPAGO_CLIENT_ID: "client-1",
    MERCADOPAGO_CLIENT_SECRET: "client-secret",
    PAYMENTS_ENCRYPTION_KEY: KEY,
    PAYMENTS_STATE_SECRET: SECRET,
  };
  owner = { ok: true, value: { tenantId: "t1" } };
});

describe("GET /api/payments/mp/connect", () => {
  it("sin sesión manda a ingresar", async () => {
    owner = { ok: false, error: { code: "no_session", message: "x" } };
    const res = await call();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/ingresar");
    expect(res.cookies.get("mp_connect")).toBeUndefined();
  });

  it("un miembro que no es dueño es rechazado y no arranca el flujo", async () => {
    owner = { ok: false, error: { code: "not_owner", message: "x" } };
    const res = await call();
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/panel/pagos");
    expect(location.searchParams.get("mp")).toBe("sin-permiso");
    expect(res.cookies.get("mp_connect")).toBeUndefined();
  });

  it("sin configuración de pagos vuelve con la bandera y sin cookie", async () => {
    env.MERCADOPAGO_CLIENT_ID = undefined;
    const res = await call();
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/panel/pagos");
    expect(location.searchParams.get("mp")).toBe("no-configurado");
    expect(res.cookies.get("mp_connect")).toBeUndefined();
  });

  it("planta la cookie y redirige a Mercado Pago con state y PKCE", async () => {
    const res = await call();
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://auth.mercadopago.com/authorization");
    expect(location.searchParams.get("client_id")).toBe("client-1");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://app.turnos.com/api/payments/mp/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();

    const state = verifyState(location.searchParams.get("state")!, SECRET, new Date());
    expect(state.ok && state.value.tenantId).toBe("t1");

    const cookie = res.cookies.get("mp_connect")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/api/payments/mp");
    expect(cookie.maxAge).toBe(600);

    // La cookie lleva el MISMO nonce que el state, y el verifier cuyo hash es el challenge.
    const opened = openConnectCookie(cookie.value, KEY);
    expect(opened.ok && opened.value.nonce).toBe(state.ok && state.value.nonce);
  });

  it("la cookie es Secure en producción", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await call();
      expect(res.cookies.get("mp_connect")!.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
