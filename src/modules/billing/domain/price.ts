import type { PlanTier } from "@/modules/tenants/domain/types";

/**
 * Precio de lista de cada plan, en centavos de DÓLAR.
 *
 * El dólar es la fuente de verdad y el peso es lo que se termina cobrando. Se
 * eligió así porque el precio en pesos de un plan cambia solo, sin que nadie
 * toque nada, cada vez que se mueve el tipo de cambio — y un número que cambia
 * solo no puede ser la referencia.
 *
 * Vive separado de `PLAN_LIMITS` a propósito: cuánto cuesta un plan y qué
 * habilita son dos preguntas distintas, y se van a mover en momentos
 * distintos. Ver `plan.ts`.
 */
const PLAN_PRICES_USD_CENTS: Record<PlanTier, number> = {
  basico: 1500,
  pro: 3500,
  premium: 7000,
};

/**
 * Precio de lista del plan, o error si el plan no está en la tabla.
 *
 * `PlanTier` es una unión de TypeScript y el valor real sale de una columna de
 * la base: si alguien agrega un valor al enum de Postgres sin tocar esta
 * tabla, el compilador no se entera. Un lookup pelado devolvería `undefined`,
 * que después se propaga como `NaN` hasta el monto cobrado. Mejor romper acá,
 * cerca del origen, que cobrar `NaN` pesos.
 */
export function priceUsdCentsFor(plan: PlanTier): number {
  // `Object.hasOwn` y no `=== undefined`: un objeto literal hereda de
  // `Object.prototype`, así que una clave como `toString` NO da `undefined`
  // sino una función, y el chequeo por undefined la dejaba pasar. Preguntar
  // por la clave propia es la única forma de que el guard guarde de verdad.
  if (!Object.hasOwn(PLAN_PRICES_USD_CENTS, plan)) {
    throw new Error(`Plan sin precio en la tabla: ${plan}`);
  }
  return PLAN_PRICES_USD_CENTS[plan];
}

/** Centavos por unidad, tanto en dólares como en pesos. */
const CENTS = 100;

/**
 * Pasa un precio en centavos de dólar a centavos de peso, a la cotización
 * dada.
 *
 * La tasa entra por parámetro y no se busca acá: el precio no puede depender
 * de que haya red en el momento en que alguien lo calcula. Quien llama trae la
 * cotización, la usa, y la guarda junto al monto — sin ese trío guardado no se
 * puede explicar después por qué un cliente pagó lo que pagó.
 *
 * Redondea HACIA ARRIBA al peso entero: un precio con centavos de peso no se
 * le muestra a nadie, y redondear para abajo sería cobrar de menos. El costo
 * máximo del redondeo es un peso.
 */
export function usdCentsToArsCents(usdCents: number, rate: number): number {
  // Ninguna de las dos entradas tiene conversión honesta si viene mal: cero
  // cobraría de menos y cualquier default cobraría un número inventado. Se
  // rompe fuerte, y se rompe por las DOS — validar sólo la tasa daba la
  // sensación de que la función se defiende mientras un monto en `NaN` salía
  // como `NaN`, que es un valor de retorno y no un error.
  if (!Number.isFinite(usdCents) || usdCents < 0) {
    throw new Error(`Monto inválido para convertir a pesos: ${usdCents}`);
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Cotización inválida para convertir a pesos: ${rate}`);
  }

  const arsCents = Math.ceil((usdCents * rate) / CENTS) * CENTS;

  // Validar las entradas no alcanza: dos números finitos pueden multiplicarse
  // hasta desbordar, y `Infinity` sale como VALOR DE RETORNO, no como error.
  // Quien llama no tiene cómo distinguirlo de un precio, que es exactamente lo
  // que esta función dice no hacer. Se chequea el resultado, no sólo lo que
  // entró.
  if (!Number.isFinite(arsCents)) {
    throw new Error(
      `La conversión a pesos desbordó: ${usdCents} centavos de dólar a ${rate}`,
    );
  }

  return arsCents;
}
