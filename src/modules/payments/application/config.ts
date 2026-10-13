import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { serverEnv } from "@/lib/env";

/**
 * Lectura de la configuración de pagos.
 *
 * Las variables son opcionales en el esquema (ver `env.ts`): un deploy sin
 * ellas tiene que seguir andando. Acá se traduce "no está" a un Result en vez
 * de dejar que el resto del módulo trabaje con `undefined`. Un valor vacío o en
 * blanco cuenta como ausente, y si `serverEnv()` mismo tira (falta otra
 * variable de la app) tampoco se propaga: pagos queda apagado, nada más.
 */

const notConfigured = () =>
  err(
    appError(
      "payments_not_configured",
      "Los pagos online no están configurados en este entorno.",
    ),
  );

function read(name: string): string | null {
  try {
    const value = (serverEnv() as Record<string, string | undefined>)[name];
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function mpClientCredentials(): Result<{ clientId: string; clientSecret: string }> {
  const clientId = read("MERCADOPAGO_CLIENT_ID");
  const clientSecret = read("MERCADOPAGO_CLIENT_SECRET");
  if (!clientId || !clientSecret) return notConfigured();
  return ok({ clientId, clientSecret });
}

export function encryptionKey(): Result<string> {
  const key = read("PAYMENTS_ENCRYPTION_KEY");
  return key ? ok(key) : notConfigured();
}

export function stateSecret(): Result<string> {
  const secret = read("PAYMENTS_STATE_SECRET");
  return secret ? ok(secret) : notConfigured();
}

/**
 * ¿Está toda la config de la plataforma? Para observabilidad (el cron avisa si
 * falta mientras algún negocio tiene pagos prendidos); el resto del módulo
 * sigue pidiendo cada valor por separado.
 */
export function paymentsConfigured(): boolean {
  return mpClientCredentials().ok && encryptionKey().ok && stateSecret().ok;
}
