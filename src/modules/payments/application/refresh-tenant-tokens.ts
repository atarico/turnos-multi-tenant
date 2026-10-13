import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

import { needsRefresh, REFRESH_LEAD_MS } from "../domain/oauth";
import { refreshTokens } from "./mercadopago-oauth";
import {
  loadTenantRefreshToken,
  markTenantMpAccountBroken,
  rotateTenantMpTokens,
} from "./mp-accounts";

/**
 * Renovación de los tokens de Mercado Pago de los negocios, para el cron.
 *
 * El access token de un negocio vence a los ~6 meses. Se renueva cuando faltan
 * menos de 30 días (`needsRefresh`): ese margen es lo que deja reintentar
 * mañana si Mercado Pago está caído hoy.
 *
 * La asimetría que manda el diseño: cada renovación ROTA el refresh token. Si
 * la respuesta llega y guardarla falla, el token viejo ya está muerto y el
 * nuevo se perdió: el negocio quedaría desconectado sin que nadie lo
 * desvinculara. Por eso se reintenta el guardado UNA vez, y si sigue fallando
 * la cuenta se marca rota (el dueño ve "reconectá" en vez de cobros que fallan
 * en silencio) y se deja un error en el log.
 *
 * Este mismo recorrido es la detección de "el vendedor desvinculó la app": un
 * refresh rechazado (`mp_rejected`) marca la cuenta rota.
 *
 * Nunca se loguea un token ni un error crudo: sólo el id del negocio y un
 * código. Las cuentas se procesan de a una y cada una va aislada, así que un
 * fallo no corta el lote.
 */

export interface RefreshSummary {
  /** Renovadas y guardadas. */
  refreshed: number;
  /** Marcadas rotas: Mercado Pago rechazó, no se pudo descifrar o no se pudo guardar. */
  broken: number;
  /** Transitorias (Mercado Pago no contestó, config ausente): se reintenta mañana. */
  skipped: number;
  /** Quedaron en un estado que no pudimos resolver (ni siquiera marcarlas rotas). */
  failed: number;
}

type Outcome = keyof RefreshSummary;

const logFailure = (tenantId: string, code: string): void => {
  console.error(
    JSON.stringify({ event: "mp_token_refresh_failed", tenantId, code }),
  );
};

async function listDueTenantIds(now: Date): Promise<Result<string[]>> {
  try {
    const threshold = new Date(now.getTime() + REFRESH_LEAD_MS).toISOString();
    const { data, error } = await createAdminClient()
      .from("tenant_mp_accounts")
      .select("tenant_id, access_token_expires_at")
      .eq("status", "connected")
      .lt("access_token_expires_at", threshold);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ tenant_id: string; access_token_expires_at: string }>;
    // La base ya filtró; `needsRefresh` es la misma regla del dominio, por si
    // alguna vez divergen el umbral de acá y el de allá.
    return ok(
      rows
        .filter((r) => needsRefresh(new Date(r.access_token_expires_at), now))
        .map((r) => r.tenant_id),
    );
  } catch {
    return err(
      appError("refresh_list_failed", "No pudimos leer las cuentas de Mercado Pago a renovar."),
    );
  }
}

async function markBroken(tenantId: string, now: Date): Promise<Outcome> {
  const marked = await markTenantMpAccountBroken(tenantId, now);
  if (marked.ok) return "broken";
  logFailure(tenantId, marked.error.code);
  return "failed";
}

async function refreshOne(tenantId: string, now: Date): Promise<Outcome> {
  const stored = await loadTenantRefreshToken(tenantId);
  if (!stored.ok) {
    // Clave rotada o dato alterado: no hay forma de renovar sin reconectar.
    if (stored.error.code === "decrypt_failed") {
      logFailure(tenantId, stored.error.code);
      return markBroken(tenantId, now);
    }
    // Ya no está conectada (carrera con una desconexión) o no hay config.
    if (["not_connected", "broken", "payments_not_configured"].includes(stored.error.code)) {
      return "skipped";
    }
    logFailure(tenantId, stored.error.code);
    return "failed";
  }

  const refreshed = await refreshTokens(stored.value, now);
  if (!refreshed.ok) {
    // 4xx: el vendedor desvinculó la app o revocó el acceso.
    if (refreshed.error.code === "mp_rejected") {
      logFailure(tenantId, refreshed.error.code);
      return markBroken(tenantId, now);
    }
    // Transitorio (o sin config): mañana se vuelve a intentar.
    return "skipped";
  }

  // GUARDADO CON REINTENTO. El refresh token anterior ya no sirve: si no se
  // guarda éste, la cuenta está perdida.
  // `account_not_connected` (0 filas) no es una falla de escritura: la cuenta
  // se desconectó o se rompió mientras tanto. No se reintenta ni se marca rota.
  let saved = await rotateTenantMpTokens(tenantId, refreshed.value, now);
  if (!saved.ok && saved.error.code !== "account_not_connected") {
    saved = await rotateTenantMpTokens(tenantId, refreshed.value, now);
  }
  if (saved.ok) return "refreshed";
  if (saved.error.code === "account_not_connected") return "skipped";

  logFailure(tenantId, saved.error.code);
  return markBroken(tenantId, now);
}

export async function refreshDueTenantTokens(
  now: Date = new Date(),
): Promise<Result<RefreshSummary>> {
  const due = await listDueTenantIds(now);
  if (!due.ok) return due;

  const summary: RefreshSummary = { refreshed: 0, broken: 0, skipped: 0, failed: 0 };
  for (const tenantId of due.value) {
    let outcome: Outcome;
    try {
      outcome = await refreshOne(tenantId, now);
    } catch {
      // Nunca se loguea la excepción: puede arrastrar un token en su mensaje.
      logFailure(tenantId, "unexpected_error");
      outcome = "failed";
    }
    summary[outcome] += 1;
  }
  return ok(summary);
}
