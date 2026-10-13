/**
 * ¿Es esta URL un checkout de Mercado Pago al que se puede mandar al cliente?
 *
 * La URL viaja desde el servidor (el `init_point` de la preferencia) y el
 * cliente la abre con `window.location.assign`. Aunque hoy la fabrica nuestro
 * servidor, una redirección abierta es un phishing servido desde el dominio
 * del negocio, así que el cliente la valida igual antes de navegar: sólo
 * https y sólo dominios de Mercado Pago.
 *
 * Dominios: `mercadopago.com` y su variante por país (`.com.ar`, `.com.br`,
 * `.com.mx`, …) —ahí caen `www.` y `sandbox.` del `init_point` y del
 * `sandbox_init_point`—. `mercadolibre.com` NO entra: la documentación sólo
 * muestra hosts de `mercadopago.com` (`www.mercadopago.com.br`,
 * `www.mercadopago.com`) y `sandbox.mercadopago.com.<cc>`. El dominio tiene que ser
 * EXACTO o un subdominio con punto: `evilmercadopago.com` y
 * `mercadopago.com.ar.evil.example` no pasan.
 */
const MP_HOST = /(^|\.)mercadopago\.com(\.[a-z]{2})?$/;

export function isMercadoPagoCheckoutUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  // Sin `user:pass@` (disfraza el host real) ni puerto explícito.
  if (url.username || url.password || url.port) return false;

  return MP_HOST.test(url.hostname.toLowerCase());
}
