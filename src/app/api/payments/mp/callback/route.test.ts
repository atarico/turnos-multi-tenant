import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sealConnectCookie } from "@/modules/payments/domain/connect-cookie";
import { signState } from "@/modules/payments/domain/oauth";

const KEY = randomBytes(32).toString("base64");
const SECRET = "secreto-de-state-largo";
let env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

let owner: unknown = { ok: true, value: { tenantId: "t1" } };
vi.mock("@/modules/payments/application/ownership", () => ({
  currentOwnerTenant: async () => owner,
}));

const exchangeCode = vi.fn();
vi.mock("@/modules/payments/application/mercadopago-oauth", () => ({
  exchangeCode: (...args: unknown[]) => exchangeCode(...args),
}));
const saveTenantMpAccount = vi.fn();
vi.mock("@/modules/payments/application/mp-accounts", () => ({
  saveTenantMpAccount: (...args: unknown[]) => saveTenantMpAccount(...args),
}));

const { GET } = await import("./route");

const NONCE = "nonce-del-flujo";
const VERIFIER = "verifier-del-flujo";
const tokens = {
  accessToken: "AT-secreto",
  refreshToken: "RT-secreto",
  expiresAt: new Date(),
  mpUserId: 99,
  publicKey: "pk",
};

function stateFor(over: { tenantId?: string; nonce?: string; issuedAt?: Date; secret?: string } = {}) {
  return signState(
    {
      tenantId: over.tenantId ?? "t1",
      nonce: over.nonce ?? NONCE,
      issuedAt: over.issuedAt ?? new Date(),
    },
    over.secret ?? SECRET,
  );
}

function cookieValue(nonce = NONCE) {
  const sealed = sealConnectCookie({ nonce, verifier: VERIFIER }, KEY);
  if (!sealed.ok) throw new Error("no selló");
  return sealed.value;
}

function call(query: Record<string, string>, cookie: string | null = cookieValue()) {
  const url = new URL("https://app.turnos.com/api/payments/mp/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return GET(
    new NextRequest(url, { headers: cookie ? { cookie: `mp_connect=${cookie}` } : {} }),
  );
}

const flagOf = (res: Response) => {
  const location = new URL(res.headers.get("location")!);
  expect(location.pathname).toBe("/panel/pagos");
  return location.searchParams.get("mp");
};

const cookieCleared = (res: ReturnType<typeof GET> extends Promise<infer R> ? R : never) => {
  const cookie = res.cookies.get("mp_connect");
  expect(cookie?.value).toBe("");
  expect(cookie?.maxAge).toBe(0);
  expect(cookie?.path).toBe("/api/payments/mp");
};

beforeEach(() => {
  vi.clearAllMocks();
  env = {
    NEXT_PUBLIC_APP_URL: "https://app.turnos.com",
    MERCADOPAGO_CLIENT_ID: "client-1",
    MERCADOPAGO_CLIENT_SECRET: "client-secret",
    PAYMENTS_ENCRYPTION_KEY: KEY,
    PAYMENTS_STATE_SECRET: SECRET,
  };
  owner = { ok: true, value: { tenantId: "t1" } };
  exchangeCode.mockResolvedValue({ ok: true, value: tokens });
  saveTenantMpAccount.mockResolvedValue({ ok: true, value: undefined });
});

/** Nada se canjeó ni se guardó. */
const nothingSaved = () => {
  expect(exchangeCode).not.toHaveBeenCalled();
  expect(saveTenantMpAccount).not.toHaveBeenCalled();
};

describe("GET /api/payments/mp/callback", () => {
  it("éxito: canjea con el verifier de la cookie, guarda y limpia la cookie", async () => {
    const res = await call({ code: "CODE-1", state: stateFor() });
    expect(flagOf(res)).toBe("conectado");
    expect(exchangeCode).toHaveBeenCalledWith({
      code: "CODE-1",
      codeVerifier: VERIFIER,
      redirectUri: "https://app.turnos.com/api/payments/mp/callback",
    });
    expect(saveTenantMpAccount).toHaveBeenCalledWith("t1", tokens);
    cookieCleared(res);
  });

  it("state adulterado: error, sin canjear ni guardar, cookie limpia", async () => {
    const res = await call({ code: "C", state: stateFor({ secret: "otro-secreto-distinto" }) });
    expect(flagOf(res)).toBe("error");
    nothingSaved();
    cookieCleared(res);
  });

  it("state basura: error", async () => {
    const res = await call({ code: "C", state: "basura" });
    expect(flagOf(res)).toBe("error");
    nothingSaved();
  });

  it("state vencido: error", async () => {
    const res = await call({
      code: "C",
      state: stateFor({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) }),
    });
    expect(flagOf(res)).toBe("error");
    nothingSaved();
    cookieCleared(res);
  });

  it("el nonce del state no coincide con el de la cookie: error", async () => {
    const res = await call({ code: "C", state: stateFor() }, cookieValue("otro-nonce"));
    expect(flagOf(res)).toBe("error");
    nothingSaved();
    cookieCleared(res);
  });

  it("sin cookie (otro navegador): error", async () => {
    const res = await call({ code: "C", state: stateFor() }, null);
    expect(flagOf(res)).toBe("error");
    nothingSaved();
  });

  it("cookie ilegible: error", async () => {
    const res = await call({ code: "C", state: stateFor() }, "no-es-un-sobre");
    expect(flagOf(res)).toBe("error");
    nothingSaved();
  });

  it("el state es de otro negocio que el de la sesión: error", async () => {
    const res = await call({ code: "C", state: stateFor({ tenantId: "t-ajeno" }) });
    expect(flagOf(res)).toBe("error");
    nothingSaved();
    cookieCleared(res);
  });

  it("el usuario ya no es dueño: sin permiso, sin canjear", async () => {
    owner = { ok: false, error: { code: "not_owner", message: "x" } };
    const res = await call({ code: "C", state: stateFor() });
    expect(flagOf(res)).toBe("sin-permiso");
    nothingSaved();
    cookieCleared(res);
  });

  it("sin sesión manda a ingresar", async () => {
    owner = { ok: false, error: { code: "no_session", message: "x" } };
    const res = await call({ code: "C", state: stateFor() });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/ingresar");
    nothingSaved();
    cookieCleared(res);
  });

  it("el usuario negó el acceso en Mercado Pago: cancelado", async () => {
    const res = await call({ error: "access_denied", state: stateFor() });
    expect(flagOf(res)).toBe("cancelado");
    nothingSaved();
    cookieCleared(res);
  });

  it("otro error de Mercado Pago: error", async () => {
    const res = await call({ error: "server_error", state: stateFor() });
    expect(flagOf(res)).toBe("error");
    nothingSaved();
  });

  it("sin code: error", async () => {
    const res = await call({ state: stateFor() });
    expect(flagOf(res)).toBe("error");
    nothingSaved();
  });

  it("falla el canje: error y no se guarda nada", async () => {
    exchangeCode.mockResolvedValue({ ok: false, error: { code: "mp_rejected", message: "x" } });
    const res = await call({ code: "C", state: stateFor() });
    expect(flagOf(res)).toBe("error");
    expect(saveTenantMpAccount).not.toHaveBeenCalled();
    cookieCleared(res);
  });

  it("falla el guardado: error, y la URL no lleva nada del canje", async () => {
    saveTenantMpAccount.mockResolvedValue({ ok: false, error: { code: "account_save_failed", message: "x" } });
    const res = await call({ code: "CODE-SECRETO", state: stateFor() });
    expect(flagOf(res)).toBe("error");
    const location = res.headers.get("location")!;
    expect(location).not.toContain("CODE-SECRETO");
    expect(location).not.toContain("AT-secreto");
    cookieCleared(res);
  });

  it("sin configuración de pagos: bandera y sin canje", async () => {
    env.PAYMENTS_STATE_SECRET = undefined;
    const res = await call({ code: "C", state: stateFor() });
    expect(flagOf(res)).toBe("no-configurado");
    nothingSaved();
  });
});
