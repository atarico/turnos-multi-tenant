import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { decryptToken, encryptToken } from "../domain/token-crypto";
import {
  loadTenantAccessToken,
  deleteTenantMpAccount,
  markTenantMpAccountBroken,
  saveTenantMpAccount,
} from "./mp-accounts";

const KEY = randomBytes(32).toString("base64");
let env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

/** Lo que devuelve (o tira) cada operación del cliente admin. */
let upsertResult: { error: unknown } = { error: null };
let selectResult: { data: unknown; error: unknown } = { data: null, error: null };
let updateResult: { error: unknown } = { error: null };
let deleteResult: { error: unknown } = { error: null };
let adminFailure: Error | null = null;

const upsert = vi.fn();
const update = vi.fn();
const updateEq = vi.fn();
const deleteEq = vi.fn();
const select = vi.fn();
const selectEq = vi.fn();
const from = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return {
      from: (table: string) => {
        from(table);
        return {
          upsert: (row: unknown, opts: unknown) => {
            upsert(row, opts);
            return Promise.resolve(upsertResult);
          },
          update: (patch: unknown) => {
            update(patch);
            return {
              eq: (col: string, val: string) => {
                updateEq(col, val);
                return Promise.resolve(updateResult);
              },
            };
          },
          delete: () => ({
            eq: (col: string, val: string) => {
              deleteEq(col, val);
              return Promise.resolve(deleteResult);
            },
          }),
          select: (cols: string) => {
            select(cols);
            return {
              eq: (col: string, val: string) => {
                selectEq(col, val);
                return { maybeSingle: () => Promise.resolve(selectResult) };
              },
            };
          },
        };
      },
    };
  },
}));

const tokens = {
  accessToken: "APP_USR-acceso",
  refreshToken: "TG-refresco",
  expiresAt: new Date("2027-04-02T12:00:00Z"),
  mpUserId: 987654321,
  publicKey: "APP_USR-publica",
};

beforeEach(() => {
  env = { PAYMENTS_ENCRYPTION_KEY: KEY };
  upsertResult = { error: null };
  selectResult = { data: null, error: null };
  updateResult = { error: null };
  deleteResult = { error: null };
  adminFailure = null;
  vi.clearAllMocks();
});

describe("saveTenantMpAccount", () => {
  it("cifra ambos tokens: lo guardado no es el texto plano y descifra al original", async () => {
    const result = await saveTenantMpAccount("tenant-1", tokens);

    expect(result.ok).toBe(true);
    expect(from).toHaveBeenCalledWith("tenant_mp_accounts");
    const [row, opts] = upsert.mock.calls[0]!;
    expect(opts).toEqual({ onConflict: "tenant_id" });
    expect(JSON.stringify(row)).not.toContain("APP_USR-acceso");
    expect(JSON.stringify(row)).not.toContain("TG-refresco");
    expect(decryptToken(row.access_token_ciphertext, KEY)).toEqual({ ok: true, value: "APP_USR-acceso" });
    expect(decryptToken(row.refresh_token_ciphertext, KEY)).toEqual({ ok: true, value: "TG-refresco" });
  });

  it("guarda el resto de las columnas y deja la cuenta conectada", async () => {
    await saveTenantMpAccount("tenant-1", tokens);

    const [row] = upsert.mock.calls[0]!;
    expect(row).toMatchObject({
      tenant_id: "tenant-1",
      mp_user_id: "987654321",
      public_key: "APP_USR-publica",
      access_token_expires_at: "2027-04-02T12:00:00.000Z",
      status: "connected",
    });
    expect(typeof row.connected_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
  });

  it("sin clave de cifrado es payments_not_configured y no toca la base", async () => {
    env = {};

    const result = await saveTenantMpAccount("tenant-1", tokens);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payments_not_configured");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("un error de la base vuelve como Result", async () => {
    upsertResult = { error: { message: "boom" } };

    const result = await saveTenantMpAccount("tenant-1", tokens);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("account_save_failed");
  });

  it("si createAdminClient tira, vuelve como Result y no se escapa", async () => {
    adminFailure = new Error("falta la service role key");

    const result = await saveTenantMpAccount("tenant-1", tokens);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("account_save_failed");
  });
});

describe("loadTenantAccessToken", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    status: "connected",
    access_token_ciphertext: (() => {
      const r = encryptToken("APP_USR-acceso", KEY);
      return r.ok ? r.value : "";
    })(),
    ...over,
  });

  it("devuelve el access token descifrado", async () => {
    selectResult = { data: row(), error: null };

    const result = await loadTenantAccessToken("tenant-1");

    expect(result).toEqual({ ok: true, value: "APP_USR-acceso" });
    expect(from).toHaveBeenCalledWith("tenant_mp_accounts");
    expect(selectEq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("no pide el refresh token", async () => {
    selectResult = { data: row(), error: null };

    await loadTenantAccessToken("tenant-1");

    expect(select.mock.calls[0]![0]).not.toContain("refresh");
  });

  it("sin fila es not_connected", async () => {
    selectResult = { data: null, error: null };

    const result = await loadTenantAccessToken("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_connected");
  });

  it("cuenta rota es broken, y no descifra", async () => {
    selectResult = { data: row({ status: "broken" }), error: null };

    const result = await loadTenantAccessToken("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("broken");
  });

  it("con la clave equivocada es decrypt_failed", async () => {
    selectResult = { data: row(), error: null };
    env = { PAYMENTS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };

    const result = await loadTenantAccessToken("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("decrypt_failed");
  });

  it("con el dato adulterado es decrypt_failed", async () => {
    selectResult = { data: row({ access_token_ciphertext: "v1.a.b.c" }), error: null };

    const result = await loadTenantAccessToken("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("decrypt_failed");
  });

  it("sin clave configurada es payments_not_configured", async () => {
    selectResult = { data: row(), error: null };
    env = {};

    const result = await loadTenantAccessToken("tenant-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payments_not_configured");
  });

  it("error de la base o cliente que tira es account_load_failed", async () => {
    selectResult = { data: null, error: { message: "boom" } };
    const a = await loadTenantAccessToken("tenant-1");
    adminFailure = new Error("x");
    const b = await loadTenantAccessToken("tenant-1");

    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("account_load_failed");
    }
  });
});

describe("markTenantMpAccountBroken", () => {
  it("marca la cuenta del negocio como rota", async () => {
    const result = await markTenantMpAccountBroken("tenant-1");

    expect(result.ok).toBe(true);
    expect(update.mock.calls[0]![0]).toMatchObject({ status: "broken" });
    expect(updateEq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("errores de la base y del cliente vuelven como Result", async () => {
    updateResult = { error: { message: "boom" } };
    const a = await markTenantMpAccountBroken("tenant-1");
    adminFailure = new Error("x");
    const b = await markTenantMpAccountBroken("tenant-1");

    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("account_update_failed");
    }
  });
});

describe("deleteTenantMpAccount", () => {
  it("borra la cuenta del negocio, y sólo la de ese negocio", async () => {
    const result = await deleteTenantMpAccount("tenant-1");

    expect(result.ok).toBe(true);
    expect(from).toHaveBeenCalledWith("tenant_mp_accounts");
    expect(deleteEq).toHaveBeenCalledWith("tenant_id", "tenant-1");
  });

  it("errores de la base y del cliente vuelven como Result", async () => {
    deleteResult = { error: { message: "boom" } };
    const a = await deleteTenantMpAccount("tenant-1");
    adminFailure = new Error("x");
    const b = await deleteTenantMpAccount("tenant-1");

    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("account_delete_failed");
    }
  });
});
