import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exchangeCode, refreshTokens } from "./mercadopago-oauth";

let env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

const NOW = new Date("2026-10-04T12:00:00Z");

const tokenBody = {
  access_token: "APP_USR-acceso",
  refresh_token: "TG-refresco",
  expires_in: 15_552_000,
  user_id: 987654321,
  public_key: "APP_USR-publica",
  scope: "offline_access read write",
  live_mode: true,
};

const response = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

function sent() {
  const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
  return { url, options, body: JSON.parse(String(options.body)) };
}

beforeEach(() => {
  env = { MERCADOPAGO_CLIENT_ID: "cid", MERCADOPAGO_CLIENT_SECRET: "csecret" };
  fetchMock = vi.fn(async () => response(200, tokenBody));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const input = { code: "TG-code", codeVerifier: "verifier", redirectUri: "https://app/cb" };

describe("exchangeCode", () => {
  it("canjea el code y devuelve los tokens tipados con el vencimiento calculado", async () => {
    const result = await exchangeCode(input, NOW);

    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: "APP_USR-acceso",
        refreshToken: "TG-refresco",
        expiresAt: new Date("2027-04-02T12:00:00Z"),
        mpUserId: 987654321,
        publicKey: "APP_USR-publica",
      },
    });
  });

  it("manda el JSON que pide Mercado Pago, sin cachear y con timeout", async () => {
    await exchangeCode(input, NOW);

    const { url, options, body } = sent();
    expect(url).toBe("https://api.mercadopago.com/oauth/token");
    expect(options.method).toBe("POST");
    expect(options.cache).toBe("no-store");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(body).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      grant_type: "authorization_code",
      code: "TG-code",
      code_verifier: "verifier",
      redirect_uri: "https://app/cb",
    });
  });

  it("sin client id o secret no sale a la red", async () => {
    env = {};

    const result = await exchangeCode(input, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payments_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("4xx es mp_rejected", async () => {
    fetchMock.mockResolvedValue(response(400, { error: "invalid_grant" }));

    const result = await exchangeCode(input, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_rejected");
  });

  it("5xx es mp_unreachable", async () => {
    fetchMock.mockResolvedValue(response(503, {}));

    const result = await exchangeCode(input, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_unreachable");
  });

  it("un timeout o error de red es mp_unreachable", async () => {
    fetchMock.mockRejectedValue(new DOMException("timeout", "TimeoutError"));

    const result = await exchangeCode(input, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_unreachable");
  });

  it.each([
    ["sin access_token", { ...tokenBody, access_token: undefined }],
    ["sin refresh_token", { ...tokenBody, refresh_token: "" }],
    ["expires_in no numérico", { ...tokenBody, expires_in: "mucho" }],
    ["sin user_id", { ...tokenBody, user_id: undefined }],
    ["sin public_key", { ...tokenBody, public_key: undefined }],
    ["no es un objeto", null],
  ])("respuesta que no cumple el esquema (%s) es mp_bad_response", async (_, body) => {
    fetchMock.mockResolvedValue(response(200, body));

    const result = await exchangeCode(input, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_bad_response");
  });

  it("un cuerpo que no es JSON es mp_bad_response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("x");
      },
    });

    const result = await exchangeCode(input, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_bad_response");
  });

  it("no filtra tokens ni secretos en el mensaje de error", async () => {
    fetchMock.mockResolvedValue(response(400, { ...tokenBody }));

    const result = await exchangeCode(input, NOW);

    expect(JSON.stringify(result)).not.toMatch(/csecret|APP_USR|TG-/);
  });
});

describe("refreshTokens", () => {
  it("renueva y devuelve el refresh token NUEVO", async () => {
    fetchMock.mockResolvedValue(
      response(200, { ...tokenBody, refresh_token: "TG-rotado" }),
    );

    const result = await refreshTokens("TG-viejo", NOW);

    expect(result.ok && result.value.refreshToken).toBe("TG-rotado");
    expect(sent().body).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      grant_type: "refresh_token",
      refresh_token: "TG-viejo",
    });
  });

  it("sin configuración es payments_not_configured", async () => {
    env = { MERCADOPAGO_CLIENT_ID: "cid" };

    const result = await refreshTokens("TG-viejo", NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payments_not_configured");
  });

  it("4xx es mp_rejected (refresh token revocado o vencido)", async () => {
    fetchMock.mockResolvedValue(response(400, { error: "invalid_grant" }));

    const result = await refreshTokens("TG-viejo", NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("mp_rejected");
  });

  it("5xx y red son mp_unreachable; esquema roto es mp_bad_response", async () => {
    fetchMock.mockResolvedValueOnce(response(500, {}));
    fetchMock.mockRejectedValueOnce(new Error("red"));
    fetchMock.mockResolvedValueOnce(response(200, { access_token: "x" }));

    const codes = [];
    for (let i = 0; i < 3; i++) {
      const r = await refreshTokens("TG-viejo", NOW);
      codes.push(r.ok ? "ok" : r.error.code);
    }

    expect(codes).toEqual(["mp_unreachable", "mp_unreachable", "mp_bad_response"]);
  });
});
