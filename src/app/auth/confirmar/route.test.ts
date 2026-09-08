import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

/**
 * Tests del portón que canjea el link del mail de recuperación.
 *
 * Esta ruta es la ÚNICA del flujo que abre una sesión sin contraseña, y le
 * pega cualquiera con una URL armada a mano. Lo que se prueba acá no es que
 * "funcione el camino feliz": es que los tres caminos torcidos —un `type`
 * inventado, un `next` que apunta afuera, y un token que ya no sirve— no
 * terminen en una sesión regalada, en otro dominio, ni en una pantalla en
 * blanco.
 */

const verifyOtp = vi.fn(async () => ({
  error: null as { message: string } | null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp } }),
}));

const ORIGIN = "http://localhost:3000";

/** Arma el GET tal como llega desde el mail. */
function confirmRequest(query: Record<string, string> = {}): NextRequest {
  const url = new URL("/auth/confirmar", ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const validQuery = { token_hash: "hash-del-mail", type: "recovery" };

/** El destino final del redirect, ya resuelto contra el origen. */
async function locationOf(query: Record<string, string>): Promise<string> {
  const response = await GET(confirmRequest(query));
  return response.headers.get("location") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyOtp.mockResolvedValue({ error: null });
});

describe("GET /auth/confirmar", () => {
  it("canjea el token y manda al formulario de contraseña nueva", async () => {
    const response = await GET(
      confirmRequest({ ...validQuery, next: "/nueva-contrasena" }),
    );

    expect(verifyOtp).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "hash-del-mail",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/nueva-contrasena`);
  });

  // ───────────────────────────────────────────────────────────
  // 1. El `type` no se reenvía: se compara
  // ───────────────────────────────────────────────────────────

  /**
   * `verifyOtp` acepta varios `type` (`signup`, `invite`, `magiclink`,
   * `email_change`…). Si el de la query se pasara tal cual, esta ruta se
   * convertiría en un canjeador universal de tokens: un link de invitación o
   * de cambio de email entraría por acá y saldría con sesión abierta rumbo a
   * un formulario para fijar contraseña. Sólo `recovery` pasa.
   */
  it("rechaza cualquier `type` que no sea recovery y no llama a verifyOtp", async () => {
    // `Recovery` y `RECOVERY` están en la lista a propósito: el `type` que
    // manda Supabase es minúscula exacta, así que aflojar la comparación a
    // algo insensible a mayúsculas sólo agranda la superficie sin ganar nada.
    for (const type of [
      "magiclink",
      "signup",
      "invite",
      "email_change",
      "Recovery",
      "RECOVERY",
      "",
    ]) {
      expect(await locationOf({ token_hash: "hash-del-mail", type })).toBe(
        `${ORIGIN}/recuperar?link=vencido`,
      );
    }

    expect(verifyOtp).not.toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────
  // 2. El `next` no puede sacar a nadie del sitio (open redirect)
  // ───────────────────────────────────────────────────────────

  /**
   * El agujero clásico: `new URL(next, request.url)` resuelve
   * `//evil.com` como `http://evil.com/`. O sea que un link armado con
   * `next=//evil.com` mandaría a la víctima —recién autenticada— a un dominio
   * ajeno, con el token de recuperación en el `Referer`. Sólo se acepta un
   * path relativo del propio sitio.
   */
  it("ignora un `next` protocol-relative que apunta a otro dominio", async () => {
    expect(await locationOf({ ...validQuery, next: "//evil.com" })).toBe(
      `${ORIGIN}/nueva-contrasena`,
    );
  });

  /**
   * La barra invertida es el mismo agujero disfrazado: el parser de URL de la
   * plataforma trata `\` como `/` en un esquema especial, así que
   * `/\evil.com` termina en `http://evil.com/` igual que `//evil.com`. Pasa
   * el control ingenuo de "empieza con una sola barra".
   */
  it("ignora un `next` que usa barra invertida para simular un path", async () => {
    expect(await locationOf({ ...validQuery, next: "/\\evil.com" })).toBe(
      `${ORIGIN}/nueva-contrasena`,
    );
  });

  it("ignora un `next` con esquema absoluto", async () => {
    expect(await locationOf({ ...validQuery, next: "https://evil.com" })).toBe(
      `${ORIGIN}/nueva-contrasena`,
    );
  });

  /**
   * Los tres agujeros que NINGÚN chequeo de prefijo sobre el string crudo
   * puede tapar, y que motivaron reescribir el guard.
   *
   * El parser de URL descarta TAB, LF y CR de la entrada ANTES de resolverla.
   * O sea que "/\t/evil.com" no empieza con "//" —empieza con "/" y un tab—
   * y pasa cualquier `startsWith`, pero al resolverlo el tab desaparece,
   * quedan dos barras y termina en http://evil.com/.
   *
   * Por eso el guard no mira la forma: resuelve el destino y compara el
   * origen. Estos tres casos son los que prueban esa diferencia.
   */
  it.each([
    ["tabulación", "/\t/evil.com"],
    ["salto de línea", "/\n/evil.com"],
    ["retorno de carro", "/\r/evil.com"],
  ])(
    "ignora un `next` que esconde el doble slash con %s",
    async (_nombre, next) => {
      expect(await locationOf({ ...validQuery, next })).toBe(
        `${ORIGIN}/nueva-contrasena`,
      );
    },
  );

  /**
   * Control positivo del guard nuevo: comparar orígenes no puede volverse tan
   * estricto que rompa el camino normal. Una URL absoluta del PROPIO sitio
   * tiene que pasar, y pasar conservando su path.
   */
  it("acepta una URL absoluta del propio origen", async () => {
    expect(
      await locationOf({ ...validQuery, next: `${ORIGIN}/panel` }),
    ).toBe(`${ORIGIN}/panel`);
  });

  it("acepta un path del propio sitio", async () => {
    expect(await locationOf({ ...validQuery, next: "/panel/ajustes" })).toBe(
      `${ORIGIN}/panel/ajustes`,
    );
  });

  // ───────────────────────────────────────────────────────────
  // 3. Nunca 500, nunca en blanco
  // ───────────────────────────────────────────────────────────

  /**
   * Los links de recuperación son de un solo uso y vencen. Que el token no
   * sirva NO es el caso raro: es el que más se ve, porque la gente abre el
   * mail viejo, o hace click dos veces. Ese camino tiene que terminar en la
   * pantalla de pedir otro link, con una explicación — no en un 500 ni en una
   * página vacía que deja a alguien creyendo que la app se rompió.
   */
  it("manda a pedir otro link cuando el token ya venció o se usó", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired" } });

    const response = await GET(confirmRequest(validQuery));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/recuperar?link=vencido`,
    );
  });

  it("manda a pedir otro link cuando el link llega sin token_hash", async () => {
    expect(await locationOf({ type: "recovery" })).toBe(
      `${ORIGIN}/recuperar?link=vencido`,
    );
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("manda a pedir otro link cuando la URL llega pelada, sin ningún parámetro", async () => {
    const response = await GET(confirmRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/recuperar?link=vencido`,
    );
  });

  it("no explota si Supabase tira en vez de devolver error", async () => {
    verifyOtp.mockRejectedValue(new Error("fetch failed"));

    const response = await GET(confirmRequest(validQuery));

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/recuperar?link=vencido`,
    );
  });
});
