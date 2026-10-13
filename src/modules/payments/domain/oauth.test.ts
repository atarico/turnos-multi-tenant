import { describe, expect, it } from "vitest";

import {
  buildAuthorizationUrl,
  createPkcePair,
  needsRefresh,
  signState,
  tokenExpiresAt,
  verifyState,
} from "./oauth";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("createPkcePair", () => {
  it("reproduce el vector de prueba del RFC 7636", () => {
    // 32 bytes que en base64url dan el verifier del apéndice B del RFC.
    const bytes = Buffer.from("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "base64url");

    const pair = createPkcePair(() => bytes);

    expect(pair.verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(pair.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("genera un verifier válido y distinto cada vez", () => {
    const a = createPkcePair();
    const b = createPkcePair();

    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("state firmado", () => {
  const secret = "secreto-de-state-de-prueba";
  const issuedAt = new Date("2026-10-04T12:00:00Z");
  const payload = { tenantId: "tenant-1", nonce: "nonce-abc", issuedAt };

  it("verifica un state recién firmado y devuelve el contenido", () => {
    const state = signState(payload, secret);

    const result = verifyState(state, secret, new Date(issuedAt.getTime() + 60_000));

    expect(result).toEqual({ ok: true, value: payload });
  });

  it("vale hasta los 10 minutos y vence después", () => {
    const state = signState(payload, secret);

    const edge = verifyState(state, secret, new Date(issuedAt.getTime() + 10 * 60_000));
    const late = verifyState(state, secret, new Date(issuedAt.getTime() + 10 * 60_000 + 1));

    expect(edge.ok).toBe(true);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("state_expired");
  });

  it("rechaza un state firmado con otro secreto", () => {
    const state = signState(payload, "otro-secreto");

    const result = verifyState(state, secret, issuedAt);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("state_invalid");
  });

  it("rechaza un state con el contenido adulterado", () => {
    const [body, mac] = signState(payload, secret).split(".");
    const forged = Buffer.from(
      JSON.stringify({ t: "tenant-2", n: "nonce-abc", i: issuedAt.getTime() }),
    ).toString("base64url");

    const result = verifyState(`${forged}.${mac}`, secret, issuedAt);

    expect(body).not.toBe(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("state_invalid");
  });

  it("un state vencido y adulterado se reporta inválido, no vencido", () => {
    const [body] = signState(payload, secret).split(".");

    const result = verifyState(`${body}.AAAA`, secret, new Date(issuedAt.getTime() + DAY_MS));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("state_invalid");
  });

  it.each(["", "sin-punto", "a.b.c", ".", "!!!.???"])(
    "rechaza un state mal formado: %j",
    (state) => {
      const result = verifyState(state, secret, issuedAt);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("state_malformed");
    },
  );

  it("un secreto vacío nunca verifica", () => {
    const state = signState(payload, secret);

    const result = verifyState(state, "", issuedAt);

    expect(result.ok).toBe(false);
  });

  it("no firma con un secreto vacío", () => {
    expect(() => signState(payload, "")).toThrow();
  });
});

describe("buildAuthorizationUrl", () => {
  it("arma la URL de autorización de Mercado Pago con PKCE", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "12345",
        redirectUri: "https://app.turnos.com/api/mp/callback",
        state: "estado.firma",
        codeChallenge: "desafio",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.mercadopago.com/authorization");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "12345",
      response_type: "code",
      platform_id: "mp",
      state: "estado.firma",
      redirect_uri: "https://app.turnos.com/api/mp/callback",
      code_challenge: "desafio",
      code_challenge_method: "S256",
    });
  });
});

describe("vencimiento del token", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  it("tokenExpiresAt suma los segundos que dice MP", () => {
    expect(tokenExpiresAt(now, 15_552_000).toISOString()).toBe("2027-04-02T12:00:00.000Z");
  });

  it("needsRefresh: faltando menos de 30 días hay que renovar", () => {
    const in30d = new Date(now.getTime() + 30 * DAY_MS);

    expect(needsRefresh(new Date(in30d.getTime() - 1), now)).toBe(true);
    expect(needsRefresh(in30d, now)).toBe(false);
    expect(needsRefresh(new Date(in30d.getTime() + 1), now)).toBe(false);
  });

  it("needsRefresh: un token ya vencido necesita renovarse", () => {
    expect(needsRefresh(new Date(now.getTime() - DAY_MS), now)).toBe(true);
  });
});
