"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

import { cancelSubscription } from "./cancel";
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
    // Sin validar acá: el código no tiene forma conocida y validarlo contra un
    // regex inventado rechazaría cupones legítimos antes de preguntarle a la
    // única fuente que sabe. `startCheckout` lo normaliza y lo canjea, y un
    // código que no sirve vuelve como `coupon_invalid`.
    couponCode: String(formData.get("coupon") ?? ""),
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

/**
 * Da de baja la suscripción del negocio.
 *
 * NO LEE UN SOLO CAMPO DEL FORMULARIO, y eso es la mitad de la seguridad de
 * esta action: como toda Server Action es alcanzable por POST directo, un
 * `tenant_id` de afuera sería la forma de dar de baja el negocio de otro. El
 * negocio sale de la sesión y de ningún otro lado — del lado SQL no hay red de
 * contención, porque `cancel_subscription()` mira el `tenant_id` que le pasan
 * y por eso está grantada sólo a `service_role`.
 *
 * Tampoco pide confirmación acá. La confirmación es de INTERFAZ y vive en la
 * pantalla: pedirla dos veces en el servidor no agrega seguridad —quien pega
 * un POST directo manda el campo igual— y sí agregaría un camino de error para
 * el dueño que apretó bien el botón.
 */
export async function cancelSubscriptionAction(
  prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Los dos parámetros existen porque los pasa `useActionState`, y NINGUNO se
  // lee. `formData` no se lee por seguridad —está explicado arriba— y `prev`
  // porque la baja no depende del intento anterior. Se los descarta a la vista
  // en vez de renombrarlos con guión bajo: el repo no tiene `argsIgnorePattern`
  // configurado, y aflojar el lint de todo el proyecto por dos argumentos es
  // peor que estas dos líneas.
  void prev;
  void formData;

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio. Volvé a ingresar.");

  const result = await cancelSubscription(tenant.id);

  if (!result.ok) {
    // El mensaje viaja tal cual, misma convención que el checkout: es lo único
    // que distingue "ya no se te cobra pero no lo registramos" de "no se pudo
    // dar de baja", y esas dos piden cosas distintas del dueño.
    return errorState(result.error.message);
  }

  // Que la pantalla muestre la baja sin que el dueño recargue. Ahí es donde va
  // a leer hasta cuándo le queda servicio, que es la pregunta que tiene apenas
  // aprieta el botón.
  revalidatePath("/panel/suscripcion");

  return {
    status: "success",
    message:
      "Listo, dimos de baja tu suscripción. No se te va a cobrar más.",
  };
}
