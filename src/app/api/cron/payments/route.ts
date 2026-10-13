import { createHash, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/lib/env";
import { appError, err, type Result } from "@/core/result";
import { cancelExpiredPaymentHolds } from "@/modules/payments/application/cancel-expired-holds";
import { paymentsConfigured } from "@/modules/payments/application/config";
import { anyTenantHasPaymentsEnabled } from "@/modules/payments/application/queries";
import { refreshDueTenantTokens } from "@/modules/payments/application/refresh-tenant-tokens";

/**
 * Mantenimiento diario de los pagos al cliente.
 *
 * Lo llama el cron de Vercel —ver `vercel.json`— con GET y
 * `Authorization: Bearer <CRON_SECRET>`, igual que `booking-reminders`. Hace
 * dos cosas independientes:
 *
 * 1. Cancela los holds de pago vencidos. Es limpieza: un hold vencido ya no
 *    ocupa cupo, pero no debe quedar como "Pendiente" para siempre.
 * 2. Renueva los tokens de Mercado Pago que vencen en menos de 30 días, y de
 *    paso detecta a los vendedores que desvincularon la app.
 *
 * Es DIARIO a propósito, para que ande en cualquier plan de Vercel; a las 6
 * UTC, lejos del cron de recordatorios (12 UTC).
 *
 * Un paso que falla NO salta al otro: no dependen entre sí, y perder la
 * renovación de tokens porque la limpieza falló (o al revés) es peor que el
 * fallo original. Sólo es 500 si fallan los DOS: un 500 hace que el cron se
 * dé por fallido, y con un paso hecho no hay nada que reintentar a ciegas
 * (los dos son idempotentes igual). El detalle viaja en la respuesta porque es
 * lo único que queda de la corrida.
 *
 * `dynamic = "force-dynamic"`: es un efecto, no se puede prerenderizar ni
 * cachear.
 */
export const dynamic = "force-dynamic";

const respond = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status });

/** Mismo criterio que en `booking-reminders`: sha256 antes de `timingSafeEqual`. */
function secretMatches(expected: string, received: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}

/** Corre un paso aislando cualquier excepción: un paso nunca tira al otro. */
async function step<T>(fn: () => Promise<Result<T>>, code: string): Promise<Result<T>> {
  try {
    return await fn();
  } catch {
    return err(appError(code, "El paso falló con una excepción."));
  }
}

/**
 * Sin la config de la plataforma la renovación se saltea (un deploy sin pagos
 * es normal). Pero si ALGÚN negocio tiene los pagos prendidos, esa config
 * ausente significa que se confirman turnos sin cobrar: se deja un error
 * estructurado, sin secretos, para que alguien lo vea.
 */
async function alertIfPaymentsInUse(): Promise<void> {
  const enabled = await step(anyTenantHasPaymentsEnabled, "payments_state_failed");
  if (enabled.ok && enabled.value) {
    console.error(JSON.stringify({ event: "payments_config_missing", tenantsWithPaymentsEnabled: true }));
  }
}

export async function GET(request: Request): Promise<Response> {
  let secret: string | undefined;
  try {
    secret = serverEnv().CRON_SECRET;
  } catch {
    return respond(500);
  }

  // SIN SECRETO EL PORTÓN QUEDA CERRADO (ver `booking-reminders`).
  if (!secret) return respond(401);

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !secretMatches(secret, token)) return respond(401);

  const holds = await step(cancelExpiredPaymentHolds, "hold_cleanup_failed");

  let tokens: Result<unknown> | "not_configured";
  if (paymentsConfigured()) {
    tokens = await step(() => refreshDueTenantTokens(), "token_refresh_failed");
  } else {
    tokens = "not_configured";
    await alertIfPaymentsInUse();
  }

  const body = {
    holds: holds.ok ? { cancelled: holds.value } : { error: holds.error.code },
    tokens:
      tokens === "not_configured"
        ? { skipped: "not_configured" }
        : tokens.ok
          ? tokens.value
          : { error: tokens.error.code },
  };

  const bothFailed = !holds.ok && tokens !== "not_configured" && !tokens.ok;
  return respond(bothFailed ? 500 : 200, body);
}
