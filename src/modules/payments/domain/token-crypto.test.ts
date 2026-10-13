import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptToken, encryptToken } from "./token-crypto";

const key = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

/** Lo que devuelve `encryptToken`, ya desempaquetado: o falla el test o hay valor. */
function encrypted(plaintext: string, k = key): string {
  const result = encryptToken(plaintext, k);
  if (!result.ok) throw new Error("encryptToken falló");
  return result.value;
}

describe("encryptToken / decryptToken", () => {
  it("hace ida y vuelta", () => {
    const envelope = encrypted("APP_USR-token-secreto");
    const back = decryptToken(envelope, key);

    expect(back).toEqual({ ok: true, value: "APP_USR-token-secreto" });
  });

  it("usa la forma v1.<iv>.<tag>.<ct> en base64url", () => {
    const parts = encrypted("x").split(".");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    // IV de 12 bytes y tag de 16.
    expect(Buffer.from(parts[1]!, "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[2]!, "base64url")).toHaveLength(16);
  });

  it("no deja el texto plano en el sobre", () => {
    expect(encrypted("APP_USR-token-secreto")).not.toContain("APP_USR");
  });

  it("usa un IV distinto en cada cifrado", () => {
    expect(encrypted("mismo")).not.toBe(encrypted("mismo"));
  });

  it("rechaza un tag adulterado", () => {
    const [v, iv, tag, ct] = encrypted("secreto").split(".");
    const flipped = Buffer.from(tag!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;

    const result = decryptToken(`${v}.${iv}.${flipped.toString("base64url")}.${ct}`, key);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("decrypt_failed");
  });

  it("rechaza un texto cifrado adulterado", () => {
    const [v, iv, tag, ct] = encrypted("secreto").split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;

    const result = decryptToken(`${v}.${iv}.${tag}.${flipped.toString("base64url")}`, key);

    expect(result.ok).toBe(false);
  });

  it("rechaza una clave equivocada", () => {
    const result = decryptToken(encrypted("secreto"), otherKey);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("decrypt_failed");
  });

  it("rechaza una versión desconocida", () => {
    const [, iv, tag, ct] = encrypted("secreto").split(".");

    const result = decryptToken(`v2.${iv}.${tag}.${ct}`, key);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_version");
  });

  it.each(["", "basura", "v1.a.b", "v1.a.b.c.d", "v1...."])(
    "rechaza un sobre mal formado sin tirar: %j",
    (envelope) => {
      const result = decryptToken(envelope, key);

      expect(result.ok).toBe(false);
    },
  );

  it("rechaza un IV de largo incorrecto", () => {
    const [v, , tag, ct] = encrypted("secreto").split(".");

    const result = decryptToken(`${v}.${Buffer.alloc(8).toString("base64url")}.${tag}.${ct}`, key);

    expect(result.ok).toBe(false);
  });

  it("rechaza claves que no miden 32 bytes, al cifrar y al descifrar", () => {
    const short = randomBytes(16).toString("base64");

    const enc = encryptToken("x", short);
    const dec = decryptToken(encrypted("x"), short);

    expect(enc.ok).toBe(false);
    expect(dec.ok).toBe(false);
    if (!enc.ok) expect(enc.error.code).toBe("invalid_key");
    if (!dec.ok) expect(dec.error.code).toBe("invalid_key");
  });

  it("no filtra el texto plano ni la clave en los mensajes de error", () => {
    const secret = "APP_USR-token-secreto";
    const enc = encryptToken(secret, "clave-corta");
    const dec = decryptToken(encrypted(secret), otherKey);

    for (const r of [enc, dec]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const text = JSON.stringify(r.error);
        expect(text).not.toContain(secret);
        expect(text).not.toContain(otherKey);
        expect(text).not.toContain("clave-corta");
      }
    }
  });
});
