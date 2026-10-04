import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * El token `k` de la URL de notificación de cada negocio.
 *
 * La URL del webhook de pagos se le entrega a Mercado Pago al crear la
 * preferencia, pero no es secreta: cualquiera puede armar
 * `?tenant=<id>&data.id=…` y hacer trabajar al servidor (una lectura de la base
 * y una llamada a Mercado Pago por request). `k` ata la URL a UN negocio con un
 * secreto que sólo tiene el servidor, así que sin él la request se descarta
 * antes de tocar nada.
 *
 * No reemplaza el re-fetch del pago: la ancla de confianza sigue siendo volver a
 * leerlo con el token del negocio. Esto sólo corta el abuso anónimo.
 */
export function notifyToken(secret: string, tenantId: string): string {
  return createHmac("sha256", secret).update(`mp-notify:${tenantId}`).digest("base64url");
}

/** Comparación en tiempo constante. Cualquier cosa rara es `false`, nunca una excepción. */
export function verifyNotifyToken(
  secret: string,
  tenantId: string,
  candidate: string | null | undefined,
): boolean {
  if (!secret || !candidate) return false;

  const expected = Buffer.from(notifyToken(secret, tenantId), "base64url");
  const received = Buffer.from(candidate, "base64url");

  // `timingSafeEqual` tira con largos distintos: se compara el largo primero.
  if (received.length !== expected.length) return false;
  // `Buffer.from(x, "base64url")` descarta lo ilegible en vez de tirar: se
  // vuelve a codificar para que un texto con basura no pase por uno válido.
  if (received.toString("base64url") !== candidate) return false;

  return timingSafeEqual(expected, received);
}
