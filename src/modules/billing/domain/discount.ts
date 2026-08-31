/** Un peso en centavos. */
const CENTS = 100;

/** Puntos básicos de un entero: 10.000 bps = 100%. */
const BPS_TOTAL = 10_000;

/**
 * Aplica un descuento a un monto en centavos de peso.
 *
 * El descuento va en puntos básicos y no en porcentaje por el mismo motivo por
 * el que la plata va en centavos: un 99,5% con float es la clase de redondeo
 * que aparece como un peso de diferencia en el resumen de la tarjeta.
 *
 * Redondea HACIA ARRIBA al peso entero, igual que `usdCentsToArsCents`. Un
 * monto con centavos de peso no se le muestra a nadie, y hacia abajo cobraría
 * menos que el descuento pactado. El costo máximo del redondeo es un peso.
 *
 * Nunca devuelve cero: un preapproval en cero lo rechaza Mercado Pago, y ese
 * rechazo llegaría recién en el checkout y de cara al cliente. El techo de
 * 9900 bps que impone la tabla `coupons` hace que este piso casi no se toque
 * — casi no es nunca, y esta función no puede confiar en que su único llamador
 * de hoy siga siendo el único mañana.
 *
 * Un descuento fuera de rango ROMPE en vez de recortarse al borde. Recortar
 * cobraría un precio que nadie pactó, y lo haría en silencio.
 */
export function applyDiscount(arsCents: number, discountBps: number): number {
  if (!Number.isFinite(arsCents) || arsCents < 0) {
    throw new Error(`Monto inválido para descontar: ${arsCents}`);
  }
  if (
    !Number.isFinite(discountBps) ||
    discountBps < 0 ||
    discountBps > BPS_TOTAL
  ) {
    throw new Error(`Descuento inválido: ${discountBps}`);
  }

  const kept = (arsCents * (BPS_TOTAL - discountBps)) / BPS_TOTAL;
  const rounded = Math.ceil(kept / CENTS) * CENTS;

  return Math.max(rounded, CENTS);
}
