/** Un cupón visto desde la plataforma. Espeja la tabla `public.coupons`. */
export interface Coupon {
  code: string;
  discount_bps: number;
  active: boolean;
  expires_at: string | null;
  max_redemptions: number | null;
  redemptions: number;
  note: string | null;
  created_at: string;
}

/**
 * Por qué un cupón no se puede canjear, o que sí se puede.
 *
 * Los tres motivos de rechazo se distinguen ACÁ y no en el checkout, y esa
 * asimetría es deliberada: `redeem_coupon` los colapsa a un solo `null` para
 * que el campo del dueño no sea un oráculo con el que adivinar códigos ajenos.
 * El operador ya sabe qué cupones existen, así que para él esconderlos no
 * protege nada y sólo lo obliga a adivinar por qué su cupón no anda.
 */
export type CouponState = "off" | "expired" | "exhausted" | "active";

/**
 * `off` gana sobre los demás porque es el único que el operador CONTROLA: si
 * apagó un cupón que además venció, lo que necesita ver es que está apagado,
 * que es lo que puede deshacer con un click. Mostrar "vencido" lo mandaría a
 * cambiar una fecha que no cambia nada.
 */
export function couponState(coupon: Coupon, now: Date): CouponState {
  if (!coupon.active) return "off";

  if (coupon.expires_at && new Date(coupon.expires_at).getTime() <= now.getTime()) {
    return "expired";
  }

  if (
    coupon.max_redemptions !== null &&
    coupon.redemptions >= coupon.max_redemptions
  ) {
    return "exhausted";
  }

  return "active";
}

/** `9900` → `"99%"`. Los bps son de la base; nadie los lee en una pantalla. */
export function discountLabel(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}
