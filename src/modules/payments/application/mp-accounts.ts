import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

import { decryptToken, encryptToken } from "../domain/token-crypto";
import { encryptionKey } from "./config";
import type { MpTokens } from "./mercadopago-oauth";

/**
 * Cuenta de Mercado Pago de cada negocio (`tenant_mp_accounts`).
 *
 * Todo va por el cliente admin porque la tabla tiene RLS sin políticas y los
 * permisos revocados: ni el dueño del negocio lee los tokens, ni siquiera
 * cifrados. Todo vuelve como Result, y `createAdminClient()` está DENTRO del
 * `try`: tira si falta la service-role key, y una excepción acá se escaparía
 * justo cuando hay un token recién canjeado que se perdería (mismo
 * aprendizaje que `billing/application/checkout.ts`).
 *
 * Los mensajes de error no incluyen tokens ni el error crudo de la base.
 */

const TABLE = "tenant_mp_accounts";

export async function saveTenantMpAccount(
  tenantId: string,
  tokens: MpTokens,
  now: Date = new Date(),
): Promise<Result<void>> {
  const key = encryptionKey();
  if (!key.ok) return key;

  const access = encryptToken(tokens.accessToken, key.value);
  if (!access.ok) return access;
  const refresh = encryptToken(tokens.refreshToken, key.value);
  if (!refresh.ok) return refresh;

  const failed = () =>
    err(
      appError(
        "account_save_failed",
        "No pudimos guardar la conexión con Mercado Pago. Intentá de nuevo.",
      ),
    );

  try {
    const { error } = await createAdminClient()
      .from(TABLE)
      .upsert(
        {
          tenant_id: tenantId,
          // La columna es `text`: el id de MP viaja como número y se guarda tal cual.
          mp_user_id: String(tokens.mpUserId),
          public_key: tokens.publicKey,
          access_token_ciphertext: access.value,
          refresh_token_ciphertext: refresh.value,
          access_token_expires_at: tokens.expiresAt.toISOString(),
          status: "connected",
          connected_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: "tenant_id" },
      );
    if (error) return failed();
  } catch {
    return failed();
  }

  return ok(undefined);
}

/**
 * Access token descifrado del negocio.
 *
 * Errores tipados para que quien llama decida: `not_connected` (nunca
 * conectó), `broken` (Mercado Pago revocó la app o falló la renovación: hay
 * que reconectar), `decrypt_failed` (clave rotada o dato alterado) y
 * `payments_not_configured`.
 */
export async function loadTenantAccessToken(tenantId: string): Promise<Result<string>> {
  const key = encryptionKey();
  if (!key.ok) return key;

  let row: { status: string; access_token_ciphertext: string } | null;
  try {
    const { data, error } = await createAdminClient()
      .from(TABLE)
      .select("status, access_token_ciphertext")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw error;
    row = data as typeof row;
  } catch {
    return err(
      appError(
        "account_load_failed",
        "No pudimos leer la conexión con Mercado Pago. Intentá de nuevo.",
      ),
    );
  }

  if (!row) {
    return err(appError("not_connected", "Este negocio no conectó Mercado Pago."));
  }
  if (row.status !== "connected") {
    return err(
      appError("broken", "La conexión con Mercado Pago se rompió. Hay que volver a conectarla."),
    );
  }

  // Cualquier falla de descifrado (sobre ilegible, versión vieja, clave que
  // no coincide, dato alterado) es la misma para quien llama: reconectar.
  const decrypted = decryptToken(row.access_token_ciphertext, key.value);
  if (decrypted.ok) return decrypted;
  return err(
    appError(
      "decrypt_failed",
      "No pudimos leer la conexión con Mercado Pago guardada. Hay que volver a conectarla.",
    ),
  );
}

export async function markTenantMpAccountBroken(
  tenantId: string,
  now: Date = new Date(),
): Promise<Result<void>> {
  try {
    const { error } = await createAdminClient()
      .from(TABLE)
      .update({ status: "broken", updated_at: now.toISOString() })
      .eq("tenant_id", tenantId);
    if (error) throw error;
  } catch {
    return err(
      appError("account_update_failed", "No pudimos actualizar la conexión con Mercado Pago."),
    );
  }
  return ok(undefined);
}

/**
 * Borra la conexión del negocio (desconectar).
 *
 * Se borra la fila entera y no se la marca como rota: los tokens cifrados no
 * tienen por qué seguir guardados cuando el dueño pidió desconectar. Quien
 * llama debe haber verificado que la sesión es la DUEÑA: este cliente saltea
 * RLS y borra lo que le pidan.
 */
export async function deleteTenantMpAccount(tenantId: string): Promise<Result<void>> {
  try {
    const { error } = await createAdminClient().from(TABLE).delete().eq("tenant_id", tenantId);
    if (error) throw error;
  } catch {
    return err(
      appError("account_delete_failed", "No pudimos desconectar la cuenta de Mercado Pago."),
    );
  }
  return ok(undefined);
}
