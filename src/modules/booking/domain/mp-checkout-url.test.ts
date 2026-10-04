import { describe, expect, it } from "vitest";

import { isMercadoPagoCheckoutUrl } from "./mp-checkout-url";

describe("isMercadoPagoCheckoutUrl", () => {
  it.each([
    "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1",
    "https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=1",
    "https://www.mercadopago.com/checkout/v1/redirect?pref_id=1",
    "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1",
    "https://mercadopago.com.mx/checkout",
    "https://www.mercadolibre.com/checkout",
  ])("acepta %s", (url) => {
    expect(isMercadoPagoCheckoutUrl(url)).toBe(true);
  });

  it.each([
    ["http en vez de https", "http://www.mercadopago.com.ar/checkout"],
    ["otro dominio", "https://evil.example/checkout"],
    ["dominio que sólo CONTIENE mercadopago", "https://mercadopago.com.ar.evil.example/x"],
    ["dominio pegado sin punto", "https://evilmercadopago.com/x"],
    ["credenciales en la URL", "https://user:pw@www.mercadopago.com.ar/x"],
    ["un puerto explícito", "https://www.mercadopago.com.ar:8443/x"],
    ["javascript:", "javascript:alert(1)"],
    ["algo que no es una URL", "no-es-url"],
    ["vacío", ""],
  ])("rechaza %s", (_label, url) => {
    expect(isMercadoPagoCheckoutUrl(url)).toBe(false);
  });
});
