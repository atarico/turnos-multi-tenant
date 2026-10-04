import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok, type Result } from "@/core/result";

import type { MpTokens } from "./mercadopago-oauth";
import { refreshDueTenantTokens } from "./refresh-tenant-tokens";

/**
 * Tests de la renovación de tokens de Mercado Pago.
 *
 * Lo que pesa acá es una asimetría: cada renovación ROTA el refresh token, así
 * que si la respuesta llega y NO se guarda, el token viejo ya está muerto y el
 * negocio queda desconectado sin que nadie lo haya desvinculado. Por eso la
 * mitad de los casos son sobre qué pasa cuando guardar falla.
 */

const NOW = new Date("2026-10-04T06:00:00.000Z");

let dueRows: Array<{ tenant_id: string; access_token_expires_at: string }> = [];
let listError: unknown = null;
let adminFailure: Error | null = null;
const eq = vi.fn();
const lt = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminFailure) throw adminFailure;
    return {
      from: () => ({
        select: () => ({
          eq: (c: string, v: unknown) => {
            eq(c, v);
            return {
              lt: (col: string, val: unknown) => {
                lt(col, val);
                return Promise.resolve({ data: dueRows, error: listError });
              },
            };
          },
        }),
      }),
    };
  },
}));

const loadRefresh = vi.fn<(t: string) => Promise<Result<string>>>();
const save = vi.fn<(t: string, tokens: MpTokens, now?: Date) => Promise<Result<void>>>();
const markBroken = vi.fn<(t: string, now?: Date) => Promise<Result<void>>>();
vi.mock("./mp-accounts", () => ({
  loadTenantRefreshToken: (t: string) => loadRefresh(t),
  rotateTenantMpTokens: (t: string, tokens: MpTokens, now?: Date) => save(t, tokens, now),
  markTenantMpAccountBroken: (t: string, now?: Date) => markBroken(t, now),
}));

const refresh = vi.fn<(token: string, now?: Date) => Promise<Result<MpTokens>>>();
vi.mock("./mercadopago-oauth", () => ({
  refreshTokens: (token: string, now?: Date) => refresh(token, now),
}));

const newTokens: MpTokens = {
  accessToken: "APP_USR-nuevo-acceso",
  refreshToken: "TG-nuevo-refresco",
  expiresAt: new Date("2027-04-01T00:00:00Z"),
  mpUserId: 777,
  publicKey: "APP_USR-publica",
};

const due = (...ids: string[]) => {
  dueRows = ids.map((tenant_id) => ({
    tenant_id,
    access_token_expires_at: "2026-10-20T00:00:00.000Z",
  }));
};

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  dueRows = [];
  listError = null;
  adminFailure = null;
  loadRefresh.mockResolvedValue(ok("TG-viejo-refresco"));
  refresh.mockResolvedValue(ok(newTokens));
  save.mockResolvedValue(ok(undefined));
  markBroken.mockResolvedValue(ok(undefined));
});

describe("refreshDueTenantTokens", () => {
  it("reads only connected accounts that expire within the 30 day lead", async () => {
    await refreshDueTenantTokens(NOW);

    expect(eq).toHaveBeenCalledWith("status", "connected");
    expect(lt).toHaveBeenCalledWith(
      "access_token_expires_at",
      new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("does nothing when no account is due", async () => {
    const result = await refreshDueTenantTokens(NOW);

    expect(result).toEqual(ok({ refreshed: 0, broken: 0, skipped: 0, failed: 0 }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores a row the database returned that is not actually due", async () => {
    dueRows = [{ tenant_id: "t-far", access_token_expires_at: "2027-03-01T00:00:00.000Z" }];

    const result = await refreshDueTenantTokens(NOW);

    expect(result).toEqual(ok({ refreshed: 0, broken: 0, skipped: 0, failed: 0 }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes with the stored refresh token and saves the ROTATED one", async () => {
    due("t-1");

    const result = await refreshDueTenantTokens(NOW);

    expect(refresh).toHaveBeenCalledWith("TG-viejo-refresco", NOW);
    expect(save).toHaveBeenCalledWith("t-1", newTokens, NOW);
    expect(result).toEqual(ok({ refreshed: 1, broken: 0, skipped: 0, failed: 0 }));
    expect(markBroken).not.toHaveBeenCalled();
  });

  it("marks the account broken when Mercado Pago rejects the refresh", async () => {
    due("t-1");
    refresh.mockResolvedValue(err(appError("mp_rejected", "no")));

    const result = await refreshDueTenantTokens(NOW);

    expect(markBroken).toHaveBeenCalledWith("t-1", NOW);
    expect(save).not.toHaveBeenCalled();
    expect(result).toEqual(ok({ refreshed: 0, broken: 1, skipped: 0, failed: 0 }));
  });

  it.each(["mp_unreachable", "mp_bad_response"])(
    "skips (and does not break) the account on %s",
    async (code) => {
      due("t-1");
      refresh.mockResolvedValue(err(appError(code, "x")));

      const result = await refreshDueTenantTokens(NOW);

      expect(markBroken).not.toHaveBeenCalled();
      expect(result).toEqual(ok({ refreshed: 0, broken: 0, skipped: 1, failed: 0 }));
    },
  );

  it("marks the account broken when the refresh token cannot be decrypted", async () => {
    due("t-1");
    loadRefresh.mockResolvedValue(err(appError("decrypt_failed", "x")));

    const result = await refreshDueTenantTokens(NOW);

    expect(refresh).not.toHaveBeenCalled();
    expect(markBroken).toHaveBeenCalledWith("t-1", NOW);
    expect(result).toEqual(ok({ refreshed: 0, broken: 1, skipped: 0, failed: 0 }));
  });

  it("retries the save once: fails then succeeds counts as refreshed", async () => {
    due("t-1");
    save
      .mockResolvedValueOnce(err(appError("account_save_failed", "x")))
      .mockResolvedValueOnce(ok(undefined));

    const result = await refreshDueTenantTokens(NOW);

    expect(save).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(markBroken).not.toHaveBeenCalled();
    expect(result).toEqual(ok({ refreshed: 1, broken: 0, skipped: 0, failed: 0 }));
  });

  it("marks the account broken and logs when the save fails twice", async () => {
    due("t-1");
    save.mockResolvedValue(err(appError("account_save_failed", "x")));

    const result = await refreshDueTenantTokens(NOW);

    expect(save).toHaveBeenCalledTimes(2);
    expect(markBroken).toHaveBeenCalledWith("t-1", NOW);
    expect(result).toEqual(ok({ refreshed: 0, broken: 1, skipped: 0, failed: 0 }));
    expect(consoleError).toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).toContain("t-1");
  });

  it("a 0-row rotation (disconnected or broken meanwhile) is skipped: no retry, no broken mark", async () => {
    due("t-1");
    save.mockResolvedValue(err(appError("account_not_connected", "x")));

    const result = await refreshDueTenantTokens(NOW);

    expect(save).toHaveBeenCalledTimes(1);
    expect(markBroken).not.toHaveBeenCalled();
    expect(result).toEqual(ok({ refreshed: 0, broken: 0, skipped: 1, failed: 0 }));
  });

  it("counts as failed when it cannot even mark the account broken", async () => {
    due("t-1");
    refresh.mockResolvedValue(err(appError("mp_rejected", "no")));
    markBroken.mockResolvedValue(err(appError("account_update_failed", "x")));

    const result = await refreshDueTenantTokens(NOW);

    expect(result).toEqual(ok({ refreshed: 0, broken: 0, skipped: 0, failed: 1 }));
    expect(consoleError).toHaveBeenCalled();
  });

  it("one account throwing never aborts the batch", async () => {
    due("t-1", "t-2", "t-3");
    loadRefresh.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const result = await refreshDueTenantTokens(NOW);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
    expect(result).toEqual(ok({ refreshed: 2, broken: 0, skipped: 0, failed: 1 }));
  });

  it("returns an error when the due accounts cannot be read", async () => {
    listError = { message: "db caída" };

    const result = await refreshDueTenantTokens(NOW);

    expect(result.ok).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns an error when the admin client cannot be built", async () => {
    adminFailure = new Error("sin service role");

    const result = await refreshDueTenantTokens(NOW);

    expect(result.ok).toBe(false);
  });

  it("never writes a token to the log", async () => {
    due("t-1", "t-2", "t-3");
    refresh
      .mockResolvedValueOnce(ok(newTokens))
      .mockResolvedValueOnce(err(appError("mp_rejected", "x")))
      .mockResolvedValueOnce(ok(newTokens));
    save
      .mockResolvedValueOnce(err(appError("account_save_failed", "x")))
      .mockResolvedValueOnce(err(appError("account_save_failed", "x")));
    markBroken.mockResolvedValue(err(appError("account_update_failed", "x")));

    await refreshDueTenantTokens(NOW);

    const logged = JSON.stringify([...consoleError.mock.calls]);
    for (const secret of ["TG-viejo-refresco", "TG-nuevo-refresco", "APP_USR-nuevo-acceso"]) {
      expect(logged).not.toContain(secret);
    }
  });
});
