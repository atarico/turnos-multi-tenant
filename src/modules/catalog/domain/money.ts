/**
 * Dinero del catálogo. Los precios se guardan SIEMPRE en centavos enteros
 * (`services.price_cents`): un float nunca representa dinero sin perder
 * precisión. Este módulo es el único borde donde se traduce a/desde texto.
 */

/** Símbolo por moneda. Sin entrada, se muestra el código ISO. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  ARS: "$",
  USD: "US$",
  EUR: "€",
};

/** Sólo dígitos, separadores y el ruido tipográfico que la gente tipea. */
const ALLOWED = /^[\d.,\s$]*$/;

/**
 * Texto tipeado por una persona → centavos enteros, o `null` si no es un monto
 * válido.
 *
 * El punto y la coma son ambiguos: "1.500" son mil quinientos en es-AR y uno
 * con medio en en-US. Se resuelve por POSICIÓN, no por locale: un separador es
 * decimal sólo si es el último y lo siguen una o dos cifras. Cualquier otro es
 * separador de miles. Así "1.500" → 150000 y "1.500,50" → 150050 sin depender
 * de la configuración regional del navegador.
 */
export function parsePriceToCents(input: string): number | null {
  const raw = input.trim();
  if (raw === "" || !ALLOWED.test(raw)) return null;

  const cleaned = raw.replace(/[\s$]/g, "");
  if (cleaned === "") return null;

  const lastSeparator = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
  const decimalDigits =
    lastSeparator === -1 ? "" : cleaned.slice(lastSeparator + 1);

  // El último separador es decimal sólo si lo siguen una o dos cifras.
  const isDecimal = decimalDigits.length === 1 || decimalDigits.length === 2;
  const wholePart = isDecimal ? cleaned.slice(0, lastSeparator) : cleaned;
  const fraction = isDecimal ? decimalDigits.padEnd(2, "0") : "00";

  const digits = wholePart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  // Un separador que no es decimal tiene que agrupar de a tres: "10,5055" no
  // es ni un monto con miles ni uno con decimales — es un error de tipeo.
  // Ojo: "10,505" SÍ es válido (diez mil quinientos cinco), porque "505"
  // agrupa de a tres. La regla mira el tamaño del grupo, no el separador.
  if (!isDecimal && !isGroupedByThousands(wholePart)) return null;

  const cents = Number(digits) * 100 + Number(fraction);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** "1.234.567" → true; "10,5055" → false. Sin separadores, también true. */
function isGroupedByThousands(value: string): boolean {
  const groups = value.split(/[.,]/);
  if (groups.length === 1) return true;
  return groups.slice(1).every((g) => g.length === 3);
}

/**
 * Centavos → texto para mostrar, con formato es-AR (miles con punto, decimales
 * con coma). Se formatea a mano en vez de con `Intl` para que la salida no
 * dependa de la versión de ICU del runtime.
 */
export function formatPrice(cents: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const whole = Math.trunc(Math.abs(cents) / 100);
  const fraction = String(Math.abs(cents) % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sign = cents < 0 ? "-" : "";

  return `${symbol} ${sign}${grouped},${fraction}`.trim();
}

/**
 * Centavos → valor para un `<input>` de precio. Sin símbolo ni separador de
 * miles: lo que se muestra tiene que poder volver por `parsePriceToCents` sin
 * ambigüedad cuando la persona lo edita.
 */
export function formatPriceInput(cents: number): string {
  const whole = Math.trunc(Math.abs(cents) / 100);
  const fraction = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole},${fraction}`;
}
