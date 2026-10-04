import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { notifyToken, verifyNotifyToken } from "./notify-token";

const SECRET = "un-secreto-de-prueba";
const TENANT = "5b1f5a3e-6f0c-4c9a-9a54-1c5b6a8f2d10";
const OTHER = "9c1f5a3e-6f0c-4c9a-9a54-1c5b6a8f2d99";

describe("notifyToken", () => {
  it("es base64url(HMAC-SHA256(secreto, 'mp-notify:' + tenant))", () => {
    const expected = createHmac("sha256", SECRET).update(`mp-notify:${TENANT}`).digest("base64url");

    expect(notifyToken(SECRET, TENANT)).toBe(expected);
  });

  it("es estable y distinto por negocio y por secreto", () => {
    expect(notifyToken(SECRET, TENANT)).toBe(notifyToken(SECRET, TENANT));
    expect(notifyToken(SECRET, TENANT)).not.toBe(notifyToken(SECRET, OTHER));
    expect(notifyToken(SECRET, TENANT)).not.toBe(notifyToken("otro", TENANT));
  });

  it("sólo usa caracteres seguros para una URL", () => {
    expect(notifyToken(SECRET, TENANT)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("verifyNotifyToken", () => {
  it("acepta el token del negocio", () => {
    expect(verifyNotifyToken(SECRET, TENANT, notifyToken(SECRET, TENANT))).toBe(true);
  });

  it("rechaza el token de OTRO negocio", () => {
    expect(verifyNotifyToken(SECRET, TENANT, notifyToken(SECRET, OTHER))).toBe(false);
  });

  it("rechaza un token hecho con otro secreto", () => {
    expect(verifyNotifyToken(SECRET, TENANT, notifyToken("otro", TENANT))).toBe(false);
  });

  it.each([null, undefined, "", "corto", "x".repeat(200), "%%%no-base64url%%%"])(
    "rechaza %j sin tirar",
    (candidate) => {
      expect(verifyNotifyToken(SECRET, TENANT, candidate as string | null)).toBe(false);
    },
  );

  it("con el secreto vacío rechaza todo (falla cerrado)", () => {
    expect(verifyNotifyToken("", TENANT, notifyToken("", TENANT))).toBe(false);
  });
});
