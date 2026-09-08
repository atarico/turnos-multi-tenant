import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import type { Coupon } from "../domain/coupon";

/**
 * Los cupones de la plataforma, del más nuevo al más viejo.
 *
 * Va por la RPC y NO por la tabla: `coupons` es deny-all con los grants
 * revocados, porque una lista legible desde una sesión es una lista de códigos
 * de descuento publicada. La reja vive dentro de `list_coupons()`.
 *
 * NO se traga los errores, por el mismo motivo que `listAllTenants`: una lista
 * vacía por un fallo de consulta le diría al operador que no tiene cupones, y
 * el siguiente paso obvio sería crear uno que ya existe.
 */
export async function listCoupons(): Promise<Result<Coupon[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_coupons");

    if (error) return failed();
    return ok((data ?? []) as unknown as Coupon[]);
  } catch {
    return failed();
  }
}

const failed = () =>
  err(
    appError("admin_coupons_query_failed", "No pudimos cargar los cupones."),
  );
