"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

import { startCheckout } from "./checkout";

/**
 * Server Actions del cobro.
 *
 * Alcanzables por POST directo, no sólo desde el botón de la pantalla: quien
 * llame puede mandar cualquier `plan`, ninguna sesión, o un `back_url` propio.
 * Por eso el negocio y el mail salen SIEMPRE del servidor, y del formulario se
 * lee un solo campo — el plan — contra una lista cerrada.
 */

/**
 * Espeja el enum `plan_tier` de la base. Cerrado a propósito: un plan fuera de
 * la lista llegaría a `priceUsdCentsFor`, que rompe, y un throw en una action
 * es un 500 en la cara del dueño en vez de un mensaje que se pueda leer.
 */
const checkoutSchema = z.object({
  plan: z.enum(["basico", "pro", "premium"]),
});

/** A dónde vuelve el pagador. Se arma acá y nunca sale del formulario. */
function backUrl(): string {
  return `${serverEnv().NEXT_PUBLIC_APP_URL}/panel/suscripcion`;
}

/**
 * Arranca el cobro de un plan y manda al dueño al checkout de la pasarela.
 *
 * Termina en `redirect()`, que lanza: nada de lo que venga después se ejecuta,
 * y por eso el redirect va afuera de cualquier `try`. Sólo se llega ahí si la
 * suscripción quedó abierta del lado de la pasarela Y estampada del nuestro.
 */
export async function startCheckoutAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = checkoutSchema.safeParse({
    plan: String(formData.get("plan") ?? ""),
  });

  if (!parsed.success) {
    return errorState("Elegí un plan válido.", zodFieldErrors(parsed.error));
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  // El mail del pagador sale de la sesión, no del formulario: es a quien
  // Mercado Pago le va a cobrar todos los meses.
  //
  // Va dentro de un `try` porque `createClient()` y `getUser()` pueden TIRAR,
  // no sólo devolver un usuario vacío: falta de configuración, la red, un token
  // que no se puede refrescar. Sin esto, todo el resto de esta función devuelve
  // mensajes que se leen y ese único camino devuelve una pantalla de error del
  // framework.
  let email: string | undefined;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    email = user?.email;
  } catch {
    email = undefined;
  }

  if (!email) {
    return errorState("No pudimos leer tu cuenta. Volvé a ingresar.");
  }

  const session = await startCheckout({
    tenantId: tenant.id,
    plan: parsed.data.plan,
    payerEmail: email,
    backUrl: backUrl(),
  });

  if (!session.ok) {
    // El mensaje viaja tal cual, que es la convención del repo. Reemplazarlo
    // por uno genérico perdería lo que distingue "probá de nuevo en un momento"
    // de "escribinos antes de reintentar" cuando quedó una suscripción abierta
    // del otro lado.
    return errorState(session.error.message);
  }

  redirect(session.value.initPoint);
}
