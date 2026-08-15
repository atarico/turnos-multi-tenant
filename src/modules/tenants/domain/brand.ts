/**
 * Color de marca del negocio: el acento con el que se pinta su página pública.
 *
 * Coincide con el default de la columna `tenants.brand_color`
 * (20260605120001_initial_schema.sql). Vive también acá porque la UI necesita
 * un valor con el que arrancar antes de que el negocio elija el suyo, y leerlo
 * de la base para eso sería un viaje de ida y vuelta por un dato constante.
 */
export const DEFAULT_BRAND_COLOR = "#6366f1";

/**
 * Un color de marca es EXACTAMENTE `#rrggbb`. Ni más corto, ni con nombre, ni
 * con función CSS.
 *
 * El ancla `^` con `$` es la mitad que importa: sin ellas, `#6366f1; color:red`
 * matchearía por su prefijo y pasaría entero. Y `$` en JavaScript también
 * matchea antes de un `\n` final, así que `#6366f1\n;color:red` se colaría —
 * por eso el flag `s` no alcanza y hace falta comparar contra la cadena
 * completa. `[0-9a-f]{6}` sin `+` cierra el largo: seis dígitos, ni cinco ni
 * siete.
 */
const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/;

/**
 * Normaliza un color de marca entrante, o devuelve `null` si no es uno.
 *
 * Devuelve `null` en vez de tirar porque el llamador siempre es una Server
 * Action que tiene que traducir el rechazo a un mensaje de formulario, no a una
 * excepción.
 *
 * La validación es LISTA BLANCA de forma, no lista negra de caracteres
 * peligrosos. El valor termina inyectado como valor de una custom property CSS
 * en la página pública: con lista negra habría que anticipar cada payload que
 * cierra una declaración y abre otra; con lista blanca, lo que no entra en el
 * molde no pasa, y no hay payload que anticipar.
 */
export function normalizeBrandColor(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  return SIX_DIGIT_HEX.test(candidate) ? candidate : null;
}

/** Un canal sRGB de 0–255 llevado a su componente lineal, según WCAG. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Color de texto legible sobre `background`: negro sobre fondos claros, blanco
 * sobre fondos oscuros.
 *
 * Hace falta porque el color de marca lo elige el negocio y puede ser
 * cualquiera. Un color de texto fijo funciona para algunos y deja ilegibles a
 * otros — blanco desaparece sobre amarillo, negro desaparece sobre azul marino.
 *
 * Los canales se PONDERAN, no se promedian: el ojo humano es mucho más
 * sensible al verde que al azul, así que `#00ff00` y `#0000ff` no se perciben
 * igual de claros aunque numéricamente sean el mismo valor. El umbral 0.179 es
 * donde se cruzan las relaciones de contraste contra negro y contra blanco.
 *
 * Un color inválido cae a texto claro: el fondo por defecto es oscuro, así que
 * es el fallback que menos rompe.
 */
export function readableTextOn(background: string): string {
  const color = normalizeBrandColor(background);
  if (!color) return "#ffffff";

  const r = linearize(parseInt(color.slice(1, 3), 16));
  const g = linearize(parseInt(color.slice(3, 5), 16));
  const b = linearize(parseInt(color.slice(5, 7), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  return luminance > 0.179 ? "#000000" : "#ffffff";
}
