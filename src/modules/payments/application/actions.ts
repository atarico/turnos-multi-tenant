"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

import {
  classifyRefundError,
  classifyToggleError,
  type PaymentsFlag,
} from "../domain/panel-flags";
import { deleteTenantMpAccount } from "./mp-accounts";
import { currentOwnerTenant } from "./ownership";

/**
 * Server Actions de `/panel/pagos`.
 *
 * Alcanzables por POST directo, no sólo desde el botón: por eso el negocio sale
 * SIEMPRE de la sesión y del formulario se lee, como mucho, el valor de un
 * interruptor contra una lista cerrada.
 *
 * Terminan en `redirect()` a la misma pantalla con una bandera FIJA (ver
 * `panel-flags`), que es como la pantalla cuenta qué pasó sin imprimir nada que
 * venga de la URL. `redirect()` lanza: va siempre afuera de cualquier `try`.
 */

const done = (flag: PaymentsFlag): never => {
  revalidatePath("/panel/pagos");
  redirect(`/panel/pagos?mp=${flag}`);
};

/**
 * Llama a `set_online_payments` con la sesión del usuario, NO con el cliente
 * admin: la función decide por `auth.uid()` si es el dueño, si el plan alcanza
 * y si hay cuenta conectada. Con el cliente admin esas tres puertas no
 * existirían.
 */
async function setOnlinePayments(
  tenantId: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; flag: PaymentsFlag }> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_online_payments", {
      p_tenant_id: tenantId,
      p_enabled: enabled,
    });
    if (error) return { ok: false, flag: classifyToggleError(error) };
    return { ok: true };
  } catch {
    return { ok: false, flag: "fallo" };
  }
}

/** Prende o apaga los pagos online. El campo `enabled` es "true" o "false". */
export async function toggleOnlinePaymentsAction(formData: FormData): Promise<void> {
  const raw = formData.get("enabled");
  if (raw !== "true" && raw !== "false") return done("fallo");

  const tenant = await getCurrentTenant();
  if (!tenant) return redirect("/ingresar");

  const enabled = raw === "true";
  const result = await setOnlinePayments(tenant.id, enabled);
  return done(result.ok ? (enabled ? "activado" : "desactivado") : result.flag);
}

/**
 * Desconecta la cuenta de Mercado Pago.
 *
 * Sólo el dueño. Primero se APAGAN los pagos y recién después se borra la
 * cuenta: si el borrado fallara a mitad de camino, el negocio queda con los
 * pagos apagados y la cuenta todavía ahí (reintentable), y nunca con los pagos
 * prendidos y sin cuenta, que dejaría a los clientes sin poder reservar.
 * No lee ningún campo del formulario.
 */
export async function disconnectMpAction(): Promise<void> {
  const owner = await currentOwnerTenant();
  if (!owner.ok) {
    return owner.error.code === "no_session" ? redirect("/ingresar") : done("sin-permiso");
  }

  const off = await setOnlinePayments(owner.value.tenantId, false);
  if (!off.ok) return done(off.flag);

  const deleted = await deleteTenantMpAccount(owner.value.tenantId);
  return done(deleted.ok ? "desconectado" : "fallo");
}

/**
 * Marca como devuelto un pago a devolver (`mark_payment_refunded`).
 *
 * Con la sesión, no con el cliente admin: la función decide por `auth.uid()` si
 * es dueño o admin del negocio de ESE pago, y revalida el estado con las filas
 * bloqueadas. Del formulario sólo se lee el id del pago; el negocio, el estado
 * y el monto salen de la base. La devolución en sí la hizo el dueño desde su
 * cuenta de Mercado Pago: esto sólo cierra el "a devolver".
 */
export async function markPaymentRefundedAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return done("fallo");

  const tenant = await getCurrentTenant();
  if (!tenant) return redirect("/ingresar");

  let flag: PaymentsFlag = "devuelto";
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("mark_payment_refunded", {
      p_booking_payment_id: id,
    });
    if (error) flag = classifyRefundError(error);
  } catch {
    flag = "fallo";
  }

  // El badge del turno en la agenda también cambia (Devolución pendiente → Devuelto).
  if (flag === "devuelto") revalidatePath("/panel");
  return done(flag);
}
