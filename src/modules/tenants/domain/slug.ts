// Acentos del español → su letra base. Cubrimos el caso real (negocios de
// LatAm y España) con caracteres precompuestos normales, sin depender de
// rangos Unicode de combining marks que ensucian el código fuente.
const ACCENT_MAP: Record<string, string> = {
  á: "a",
  é: "e",
  í: "i",
  ó: "o",
  ú: "u",
  ü: "u",
  ñ: "n",
};

/**
 * Genera un slug URL-safe desde el nombre del negocio.
 *
 *   "Peluquería Martín & Co."  ->  "peluqueria-martin-co"
 *
 * El resultado respeta el CHECK de la tabla tenants:
 *   ^[a-z0-9]+(?:-[a-z0-9]+)*$
 *
 * Lógica PURA y determinística: sin I/O, fácil de testear.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (ch) => ACCENT_MAP[ch] ?? ch)
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // todo lo no alfanumérico → guión
    .replace(/^-+|-+$/g, ""); // sin guiones en los bordes
}

/**
 * Sufijo corto y aleatorio para desambiguar slugs repetidos
 * (ej: dos "Estudio Pilates" → "estudio-pilates" y "estudio-pilates-a1b2").
 */
export function randomSuffix(length = 4): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length);
}

/**
 * Única fuente de verdad para el slug de un tenant. La usan tanto el alta
 * desde el onboarding (`tenants/application/actions.ts`) como la del registro
 * (`auth/application/actions.ts`): tener una sola implementación evita que
 * los dos caminos se desincronicen.
 */
export function generateTenantSlug(name: string): string {
  return `${slugify(name) || "negocio"}-${randomSuffix()}`;
}
