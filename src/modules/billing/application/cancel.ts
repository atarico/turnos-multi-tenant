import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createAdminClient } from "@/lib/supabase/admin";

import { cancelPreapproval } from "./mercadopago";
import { getLiveSubscriptionForCancel } from "./queries";

/**
 * Cómo terminó una baja, cuando terminó bien.
 *
 * `already_canceled` es ÉXITO y no un caso raro: el botón se aprieta dos
 * veces, o el webhook `preapproval.cancelled` llegó antes que nuestra
 * escritura. Al dueño le pasó lo que pidió, y decirle que falló lo mandaría a
 * reintentar algo que ya está hecho.
 */
export type CancelOutcome = "canceled" | "already_canceled";

/**
 * La baja se aplicó en la pasarela pero no quedó registrada de este lado.
 *
 * Vive en una constante porque los dos modos de fallar —el rpc devuelve error
 * y `createAdminClient()` TIRA— dejan al dueño en la misma situación y tienen
 * que decirle lo mismo. Y lo que dice importa: lo primero que necesita saber
 * es que YA NO SE LE COBRA. Un "no pudimos dar de baja" a secas lo manda a
 * reintentar algo que del lado de la plata ya está resuelto, o a escribirnos
 * asustado un domingo.
 */
const notRecorded = () =>
  err(
    appError(
      "cancel_not_recorded",
      "Dimos de baja el cobro en Mercado Pago —no se te va a cobrar más— pero " +
        "no pudimos terminar de registrarlo acá. Se corrige solo en unos " +
        "minutos; si no, escribinos.",
    ),
  );

/**
 * Da de baja la suscripción del negocio.
 *
 * EL ORDEN ES EL DISEÑO, igual que en `startCheckout`, y acá los dos
 * desenlaces feos NO son simétricos:
 *
 *   1. Leer la suscripción viva. Su lectura devuelve `Result` justamente para
 *      poder distinguir "no tiene" de "la base no contestó": dar de baja por
 *      las dudas sobre un fallo de lectura es tan malo como negarle la baja a
 *      alguien que sí la tiene.
 *   2. Cortar el cobro en Mercado Pago. Si esto falla, NO SE ESCRIBE NADA.
 *   3. Recién ahí escribir nuestra fila.
 *
 * Invertir 2 y 3 deja el peor final posible: la pantalla dice "dado de baja" y
 * la tarjeta se sigue debitando todos los meses, y nadie se entera hasta el
 * resumen. Al revés, la ventana fea es benigna y encima se cura sola — Mercado
 * Pago dejó de cobrar y el webhook `preapproval.cancelled` corrige la fila
 * cuando llegue. Por eso tiene su propio código de error y un mensaje que
 * empieza contando que la plata ya está a salvo.
 *
 * NO decide si quien pide la baja es el dueño. Eso ya lo resolvió el server
 * action con la sesión en la mano, que es el mismo reparto que usa el resto
 * del módulo: `cancel_subscription()` mira el `tenant_id` que le pasan y por
 * eso está grantada sólo a `service_role`.
 */
export async function cancelSubscription(
  tenantId: string,
): Promise<Result<CancelOutcome>> {
  const subscription = await getLiveSubscriptionForCancel(tenantId);
  if (!subscription.ok) return subscription;

  const { providerSubscriptionId } = subscription.value;

  // Sin preapproval no hay nada que cortar: el negocio está en la prueba y
  // nunca pasó por el checkout. Pedirle a Mercado Pago que cancele algo que no
  // existe da 404, que vuelve como `mp_rejected` y frenaría una baja
  // perfectamente legítima.
  if (providerSubscriptionId) {
    const canceled = await cancelPreapproval(providerSubscriptionId);
    if (!canceled.ok) return canceled;
  }

  let applied: { data: unknown; error: unknown };
  try {
    // TODO EL BLOQUE dentro del `try`, incluida la creación del cliente:
    // `createAdminClient()` revienta si falta la service-role key, y mirar
    // sólo `applied.error` deja afuera ese camino. Mismo aprendizaje que en
    // `checkout.ts` y `webhook.ts`.
    const admin = createAdminClient();
    applied = await admin.rpc("cancel_subscription", { p_tenant_id: tenantId });
  } catch {
    return notRecorded();
  }

  if (applied.error) return notRecorded();

  if (applied.data === "canceled" || applied.data === "already_canceled") {
    return ok(applied.data);
  }

  // Queda `no_subscription`, que después de que la lectura encontró una viva
  // significa que algo la movió en el medio. No se disfraza de éxito: lo único
  // peor que un estado raro es esconderlo.
  return notRecorded();
}
