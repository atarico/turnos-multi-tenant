import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok, type Result } from "@/core/result";

/**
 * Tests del cron de pagos: auth idéntica a la de los recordatorios, y la regla
 * de que un paso que falla NO salta al otro (limpiar holds y renovar tokens no
 * dependen entre sí).
 */

let env: Record<string, string | undefined> = {};
let envThrows = false;
vi.mock("@/lib/env", () => ({
  serverEnv: () => {
    if (envThrows) throw new Error("entorno inválido");
    return env;
  },
}));

const cancelHolds = vi.fn<() => Promise<Result<number>>>();
vi.mock("@/modules/payments/application/cancel-expired-holds", () => ({
  cancelExpiredPaymentHolds: () => cancelHolds(),
}));

const refreshTokens = vi.fn<() => Promise<Result<unknown>>>();
vi.mock("@/modules/payments/application/refresh-tenant-tokens", () => ({
  refreshDueTenantTokens: () => refreshTokens(),
}));

let configured = true;
vi.mock("@/modules/payments/application/config", () => ({
  paymentsConfigured: () => configured,
}));

const anyEnabled = vi.fn<() => Promise<Result<boolean>>>();
vi.mock("@/modules/payments/application/queries", () => ({
  anyTenantHasPaymentsEnabled: () => anyEnabled(),
}));

const { GET } = await import("./route");

const SECRET = "un-secreto-largo-de-cron";
const summary = { refreshed: 2, broken: 1, skipped: 0, failed: 0 };
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

const call = (authorization?: string) =>
  GET(
    new Request("https://app.turnos.com/api/cron/payments", {
      headers: authorization ? { authorization } : {},
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  envThrows = false;
  env = { CRON_SECRET: SECRET };
  configured = true;
  cancelHolds.mockResolvedValue(ok(3));
  refreshTokens.mockResolvedValue(ok(summary));
  anyEnabled.mockResolvedValue(ok(false));
});

describe("GET /api/cron/payments", () => {
  it.each([
    ["without the header", undefined],
    ["with a wrong secret", "Bearer otro"],
    ["with a non Bearer scheme", `Basic ${SECRET}`],
    ["with an empty token", "Bearer "],
  ])("rejects %s and runs nothing", async (_, header) => {
    const response = await call(header);

    expect(response.status).toBe(401);
    expect(cancelHolds).not.toHaveBeenCalled();
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("without a configured secret the gate stays closed", async () => {
    env = {};

    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    expect(cancelHolds).not.toHaveBeenCalled();
  });

  it("an invalid environment is a 500 that does not leak the exception", async () => {
    envThrows = true;

    expect((await call(`Bearer ${SECRET}`)).status).toBe(500);
    expect(cancelHolds).not.toHaveBeenCalled();
  });

  it("an arbitrary token length is a 401, never a 500", async () => {
    for (const token of ["x", "x".repeat(5000)]) {
      expect((await call(`Bearer ${token}`)).status).toBe(401);
    }
  });

  it("happy path: runs both steps and returns the counts", async () => {
    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      holds: { cancelled: 3 },
      tokens: summary,
    });
  });

  it("skips the refresh when the platform config is missing, without alerting if nobody uses payments", async () => {
    configured = false;

    const response = await call(`Bearer ${SECRET}`);

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tokens: { skipped: "not_configured" } });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs a structured error, with no secrets, when config is missing and some tenant has payments on", async () => {
    configured = false;
    anyEnabled.mockResolvedValue(ok(true));

    await call(`Bearer ${SECRET}`);

    expect(consoleError).toHaveBeenCalledOnce();
    const line = String(consoleError.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ event: "payments_config_missing" });
    expect(line).not.toContain(SECRET);
  });

  it("a failing hold cleanup still refreshes the tokens", async () => {
    cancelHolds.mockResolvedValue(err(appError("hold_cleanup_failed", "x")));

    const response = await call(`Bearer ${SECRET}`);

    expect(refreshTokens).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      holds: { error: "hold_cleanup_failed" },
      tokens: summary,
    });
  });

  it("a failing refresh still reports the holds that were cancelled", async () => {
    refreshTokens.mockResolvedValue(err(appError("refresh_list_failed", "x")));

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      holds: { cancelled: 3 },
      tokens: { error: "refresh_list_failed" },
    });
  });

  it("an exception in one step is contained too", async () => {
    cancelHolds.mockRejectedValue(new Error("boom"));

    const response = await call(`Bearer ${SECRET}`);

    expect(refreshTokens).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });

  it("is a 500 only when both steps fail", async () => {
    cancelHolds.mockResolvedValue(err(appError("hold_cleanup_failed", "x")));
    refreshTokens.mockResolvedValue(err(appError("refresh_list_failed", "x")));

    expect((await call(`Bearer ${SECRET}`)).status).toBe(500);
  });
});
