import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openConnectCookie, sealConnectCookie } from "./connect-cookie";
import { encryptToken } from "./token-crypto";

const KEY = randomBytes(32).toString("base64");

describe("connect cookie", () => {
  it("devuelve lo que se selló", () => {
    const sealed = sealConnectCookie({ nonce: "nonce-secreto", verifier: "verifier-secreto" }, KEY);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    // Cifrada: ni el nonce ni el verifier viajan legibles.
    expect(sealed.value).not.toContain("verifier-secreto");
    const opened = openConnectCookie(sealed.value, KEY);
    expect(opened).toEqual({ ok: true, value: { nonce: "nonce-secreto", verifier: "verifier-secreto" } });
  });

  it("rechaza un valor adulterado, de otra clave o ausente", () => {
    const sealed = sealConnectCookie({ nonce: "nonce-secreto", verifier: "verifier-secreto" }, KEY);
    if (!sealed.ok) throw new Error("no selló");
    expect(openConnectCookie(`${sealed.value}x`, KEY).ok).toBe(false);
    expect(openConnectCookie(sealed.value, randomBytes(32).toString("base64")).ok).toBe(false);
    expect(openConnectCookie("", KEY).ok).toBe(false);
    expect(openConnectCookie(undefined, KEY).ok).toBe(false);
  });

  it("rechaza un contenido que descifra pero no tiene la forma", () => {
    // Un sobre válido de otra cosa (p. ej. un token) no es una cookie de conexión.
    const other = encryptToken(JSON.stringify({ a: 1 }), KEY);
    if (!other.ok) throw new Error("no cifró");
    expect(openConnectCookie(other.value, KEY).ok).toBe(false);
  });
});
