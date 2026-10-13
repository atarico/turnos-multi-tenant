import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * ¿Este negocio exige pago al reservar online? Pregunta a
 * `tenant_requires_payment()`, la ÚNICA que lo decide (flag prendido Y plan
 * efectivo >= pro Y cuenta conectada).
 *
 * Es sólo para mostrar: avisa al cliente "se paga al reservar" ANTES de que
 * elija. Quien decide si hay hold es la base al crear la reserva. Por eso
 * falla SEGURO a `false`: ante cualquier duda no se anuncia un cobro que quizá
 * no se haga, y la reserva sigue siendo correcta igual. El cliente admin se
 * crea dentro del `try`: tira si falta la service-role key.
 */
export async function tenantRequiresPayment(tenantId: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("tenant_requires_payment", {
      p_tenant_id: tenantId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
