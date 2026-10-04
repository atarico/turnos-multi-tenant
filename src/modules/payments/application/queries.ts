import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Lo que la pantalla de pagos necesita saber de un negocio.
 *
 * Se lee por el cliente admin porque `tenant_mp_accounts` no tiene política
 * para ningún rol de sesión. Sólo se piden `status` y `connected_at`: las
 * columnas cifradas no salen de la capa de datos ni hacia el servidor de la
 * página, menos hacia el cliente. Quien llama TIENE que haber resuelto el
 * negocio con `getCurrentTenant()` antes: este cliente saltea RLS y confía en
 * el `tenantId` que le pasan.
 */

export interface PaymentsAccount {
  /** Un estado que no es `connected` se lee como roto: ante la duda, reconectar. */
  status: "connected" | "broken";
  connectedAt: string;
}

export interface PaymentsState {
  enabled: boolean;
  account: PaymentsAccount | null;
}

export async function getPaymentsState(tenantId: string): Promise<Result<PaymentsState>> {
  try {
    const admin = createAdminClient();

    const tenantQuery = await admin
      .from("tenants")
      .select("online_payments_enabled")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantQuery.error || !tenantQuery.data) throw tenantQuery.error ?? new Error("sin negocio");

    const accountQuery = await admin
      .from("tenant_mp_accounts")
      .select("status, connected_at")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (accountQuery.error) throw accountQuery.error;

    const row = accountQuery.data as { status: string; connected_at: string } | null;
    return ok({
      enabled: Boolean(
        (tenantQuery.data as { online_payments_enabled: boolean }).online_payments_enabled,
      ),
      account: row
        ? {
            status: row.status === "connected" ? "connected" : "broken",
            connectedAt: row.connected_at,
          }
        : null,
    });
  } catch {
    return err(
      appError("payments_state_failed", "No pudimos leer el estado de los pagos online."),
    );
  }
}

/**
 * ¿Algún negocio tiene los pagos online prendidos? Sólo lo usa el cron, para
 * saber si una config ausente es un deploy sin pagos (normal) o un problema.
 */
export async function anyTenantHasPaymentsEnabled(): Promise<Result<boolean>> {
  try {
    const { data, error } = await createAdminClient()
      .from("tenants")
      .select("id")
      .eq("online_payments_enabled", true)
      .limit(1);
    if (error) throw error;
    return ok(((data as unknown[] | null) ?? []).length > 0);
  } catch {
    return err(
      appError("payments_state_failed", "No pudimos leer el estado de los pagos online."),
    );
  }
}
