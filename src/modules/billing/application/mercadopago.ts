import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { serverEnv } from "@/lib/env";

/**
 * Lo que hace falta para abrir una suscripción en Mercado Pago.
 *
 * El monto viaja en CENTAVOS de peso, como toda la plata del proyecto, y se
 * convierte a pesos recién al armar el cuerpo del request. Quien llama trae el
 * monto ya convertido con la cotización del día y estampado en la fila de la
 * suscripción: acá no se cotiza nada.
 */
export interface PreapprovalDraft {
  /** El id de NUESTRA suscripción. Viaja como `external_reference`. */
  subscriptionId: string;
  /** Lo que el pagador ve en el resumen de la tarjeta. */
  reason: string;
  payerEmail: string;
  amountArsCents: number;
  /** A dónde vuelve el pagador cuando termina en Mercado Pago. */
  backUrl: string;
}

/** Una suscripción abierta del lado de la pasarela, todavía sin medio de pago. */
export interface PreapprovalSession {
  /** El id de Mercado Pago. Va a `subscriptions.provider_subscription_id`. */
  providerSubscriptionId: string;
  /** A dónde mandar al pagador para que ponga la tarjeta. */
  initPoint: string;
}

const ENDPOINT = "https://api.mercadopago.com/preapproval";

/**
 * Corte de tiempo, más largo que el de la cotización porque del otro lado hay
 * una escritura y no una lectura.
 *
 * OJO con lo que significa que esto corte: un POST que se corta por tiempo
 * puede haberse ejecutado igual del lado de ellos. Por eso el reintento NO es
 * automático — quien llama recibe `mp_unreachable` y decide, y el
 * `external_reference` es lo que después permite reconocer un preapproval
 * huérfano como perteneciente a esta suscripción.
 */
const TIMEOUT_MS = 10_000;

/** Centavos por peso. */
const CENTS = 100;

/** Se cobra una vez por mes. */
const FREQUENCY = 1;
const FREQUENCY_TYPE = "months";
const CURRENCY = "ARS";

/**
 * Los tres fallos NO son el mismo problema, y quien llama tiene que poder
 * distinguirlos porque la acción que corresponde es distinta en cada uno.
 *
 * `mp_unreachable` es transitorio: no contestó, tardó demasiado, o devolvió
 * 5xx. Reintentar sirve.
 *
 * `mp_rejected` es nuestra request mal armada: contestó 4xx. Reintentar la
 * misma request devuelve lo mismo para siempre; hay que ir a mirar qué se
 * mandó. Decirle al usuario "probá de nuevo" acá sería mentirle.
 *
 * `mp_bad_response` es contrato roto: contestó 2xx pero con algo inservible —
 * un campo renombrado río arriba, una respuesta a medias. Tampoco se arregla
 * reintentando, pero el que lo arregla no es el mismo que en `mp_rejected`.
 */
const unreachable = () =>
  err(
    appError(
      "mp_unreachable",
      "No pudimos comunicarnos con Mercado Pago. Intentá de nuevo en un momento.",
    ),
  );

const rejected = () =>
  err(
    appError(
      "mp_rejected",
      "Mercado Pago rechazó la solicitud de suscripción. Si sigue pasando, avisanos.",
    ),
  );

const badResponse = () =>
  err(
    appError(
      "mp_bad_response",
      "Mercado Pago respondió algo que no podemos usar. Si sigue pasando, avisanos.",
    ),
  );

const invalidAmount = () =>
  err(
    appError(
      "mp_invalid_amount",
      "El monto de la suscripción no es válido. No se intentó ningún cobro.",
    ),
  );

/** Un texto que sirve como identificador: existe, es texto, y no está en blanco. */
function usableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Abre una suscripción en Mercado Pago y devuelve a dónde mandar al pagador.
 *
 * Nace en `pending` y SIN medio de pago: la tarjeta la carga el pagador en el
 * checkout de Mercado Pago, no acá. La alternativa (`authorized` con
 * `card_token_id`) exigiría que los datos de tarjeta pasen por nuestro
 * servidor, que es responsabilidad que no queremos y no necesitamos.
 *
 * FALLA CERRADO. Una sesión a medias —sin id o sin punto de checkout— es peor
 * que ninguna: dejaría una fila diciendo que se está cobrando cuando no se
 * está cobrando nada. Por eso no hay valor por defecto ni respuesta parcial
 * aceptable.
 */
export async function createPreapproval(
  draft: PreapprovalDraft,
): Promise<Result<PreapprovalSession>> {
  // Se valida ANTES de salir. Un monto que no es un múltiplo entero de cien
  // centavos no vino de `usdCentsToArsCents` —que redondea al peso entero—,
  // vino de alguien que lo armó a mano. Frenarlo acá lo frena antes de que
  // exista una suscripción cobrando cualquier cosa, y sin gastar un llamado.
  const { amountArsCents } = draft;
  if (
    !Number.isFinite(amountArsCents) ||
    amountArsCents <= 0 ||
    amountArsCents % CENTS !== 0
  ) {
    return invalidAmount();
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serverEnv().MERCADOPAGO_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        reason: draft.reason,
        external_reference: draft.subscriptionId,
        payer_email: draft.payerEmail,
        back_url: draft.backUrl,
        status: "pending",
        auto_recurring: {
          frequency: FREQUENCY,
          frequency_type: FREQUENCY_TYPE,
          // `transaction_amount` va en PESOS. Toda la plata del proyecto viaja
          // en centavos, así que la división es el borde donde las dos
          // unidades se tocan — y mandarlo sin dividir cobra cien veces de más.
          transaction_amount: amountArsCents / CENTS,
          currency_id: CURRENCY,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // `no-store` explícito por el mismo motivo que en `fx.ts`: el default de
      // `fetch` en Next 16 es contextual. Un POST no debería cachearse nunca,
      // pero eso lo decide este módulo y no el orden en que lo llamaron.
      cache: "no-store",
    });
  } catch {
    // Nunca hubo respuesta: red caída o corte por tiempo. El mensaje sale de
    // una constante y no del error atrapado, así que no puede arrastrar el
    // token de acceso hacia la pantalla del usuario.
    return unreachable();
  }

  if (!response.ok) {
    return response.status >= 500 ? unreachable() : rejected();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return badResponse();
  }

  const { id, init_point: initPoint } = (body ?? {}) as {
    id?: unknown;
    init_point?: unknown;
  };

  if (!usableString(id) || !usableString(initPoint)) return badResponse();

  return ok({ providerSubscriptionId: id, initPoint });
}
