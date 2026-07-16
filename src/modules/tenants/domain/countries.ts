export const SUPPORTED_COUNTRIES = [
  "AR",
  "MX",
  "CL",
  "CO",
  "UY",
  "PE",
  "US",
  "ES",
] as const;

export type CountryCode = (typeof SUPPORTED_COUNTRIES)[number];

export const COUNTRY_LABELS: Record<CountryCode, string> = {
  AR: "Argentina",
  MX: "México",
  CL: "Chile",
  CO: "Colombia",
  UY: "Uruguay",
  PE: "Perú",
  US: "Estados Unidos",
  ES: "España",
};

export type PaymentProviderId = "mercadopago" | "stripe";

// US y España cobran con Stripe; el resto de LatAm con Mercado Pago.
const STRIPE_COUNTRIES = new Set<CountryCode>(["US", "ES"]);

/**
 * Resuelve la pasarela de pago según el país del negocio.
 *
 * Esta es LA regla de negocio que decidimos en el arranque: el botón de pago
 * que ve el cliente depende de dónde opera el comercio. Acá vive centralizada
 * y como lógica pura; la implementación concreta de cada pasarela llega en la
 * Fase 3 (patrón Strategy sobre este id).
 */
export function paymentProviderFor(country: string): PaymentProviderId {
  return STRIPE_COUNTRIES.has(country as CountryCode) ? "stripe" : "mercadopago";
}
