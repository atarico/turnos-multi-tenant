import { appError, err, ok, type Result } from "@/core/result";

/**
 * Una cotización usada para convertir el precio de un plan a pesos.
 *
 * Los tres campos viajan juntos y se guardan juntos en la suscripción: la base
 * exige tasa, fuente y fecha o ninguna (`subscriptions_fx_complete`). Sin ese
 * trío no se puede explicar después por qué un cliente pagó lo que pagó.
 */
export interface FxQuote {
  /** Pesos por dólar. */
  rate: number;
  source: string;
  quotedAt: Date;
}

/**
 * El MEP. En esta API la `casa` se llama `bolsa` — `/v1/dolares/mep` no existe
 * y devuelve 404. Es el tipo de cambio al que se accede a dólares por la vía
 * bursátil, que es la referencia razonable para un precio en dólares cobrado
 * en pesos.
 */
const ENDPOINT = "https://dolarapi.com/v1/dolares/bolsa";
const SOURCE = "dolarapi:bolsa";

/**
 * Corte de tiempo. Esto se llama desde el checkout: si el servicio de
 * cotización se cuelga, tiene que fallar rápido y decir que no se pudo cobrar,
 * no dejar a alguien mirando un spinner.
 */
const TIMEOUT_MS = 5_000;

/**
 * Banda de plausibilidad para la cotización, en pesos por dólar.
 *
 * NO pretende seguir al mercado: si tuviera que actualizarse cuando el dólar
 * se mueve, sería exactamente el número que cambia solo del que huimos al
 * poner los precios en dólares. Es un filtro de BASURA — atajar un `1` o un
 * `1e9` que llegan de una respuesta corrupta, un campo renombrado río arriba
 * o un endpoint que devolvió otra cosa.
 *
 * Deliberadamente anchísima: con el dólar en el orden de los 1.500 pesos, el
 * techo está unas 6.500 veces más arriba. Aun así es un TECHO DURO — el día
 * que el mercado lo pase, no se puede cobrar hasta que alguien toque este
 * número. Por eso la falla que produce es `fx_bad_response` y no
 * `fx_unreachable`: dice "esto no se arregla reintentando" en vez de mandar a
 * todo el mundo a probar de nuevo para siempre.
 */
const MIN_PLAUSIBLE_RATE = 100;
const MAX_PLAUSIBLE_RATE = 10_000_000;

/**
 * Cuán vieja puede ser una cotización para todavía servir.
 *
 * Tres días cubre un fin de semana largo con el mercado cerrado —la fecha del
 * dólar bolsa no se mueve sábado ni domingo— sin llegar a aceptar un servicio
 * que se quedó congelado hace semanas devolviendo siempre lo mismo.
 *
 * El margen hacia el futuro es chico y existe sólo por desfasaje de relojes.
 * Una fecha adelantada de verdad no es un dato conservador: es una señal de
 * que del otro lado algo anda mal.
 */
const MAX_QUOTE_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

/**
 * Los dos fallos NO son el mismo problema, y colapsarlos deja ciego al que
 * tiene que arreglarlo.
 *
 * `fx_unreachable` es transitorio: el servicio no contestó, tardó demasiado o
 * devolvió un error HTTP. Reintentar tiene sentido y el mensaje lo dice.
 *
 * `fx_bad_response` es de contrato: contestó, pero con algo que no podemos
 * usar — un campo renombrado río arriba, una tasa fuera de toda escala, una
 * fecha ilegible. Reintentar NO lo arregla, y decirle al usuario "probá en un
 * momento" sería mentirle mientras el problema se queda para siempre.
 */
const unreachable = () =>
  err(
    appError(
      "fx_unreachable",
      "No pudimos comunicarnos con el servicio de cotización. Intentá de nuevo en un momento.",
    ),
  );

const badResponse = () =>
  err(
    appError(
      "fx_bad_response",
      "El servicio de cotización respondió algo que no podemos usar. Si sigue pasando, avisanos.",
    ),
  );

/**
 * Cotización del dólar para cobrar un plan, o error.
 *
 * Usa el precio de **venta**: para quedar entero en dólares hay que mirar a
 * cuánto se compra un dólar en el mercado, que es su precio de venta. Tomar
 * `compra` cobraría de menos en cada suscripción.
 *
 * FALLA CERRADO ante cualquier respuesta que no sea exactamente lo esperado.
 * Este número termina siendo el monto que se le cobra a alguien: una tasa
 * inventada es peor que no poder cobrar. Por eso no hay valor por defecto, ni
 * última cotización conocida, ni nada que "siga andando" — quien llama tiene
 * que poder distinguir "no se pudo" de "el precio es este".
 *
 * Y cuando no se pudo, distingue POR QUÉ: devuelve `fx_unreachable` si el
 * servicio no contestó (reintentable) o `fx_bad_response` si contestó algo
 * inutilizable (no se arregla reintentando). Ver el bloque de arriba.
 */
export async function quoteUsdToArs(
  now: Date = new Date(),
): Promise<Result<FxQuote>> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // `no-store` EXPLÍCITO, no por confiar en el default.
      //
      // En Next 16 sin Cache Components el default de `fetch` es contextual:
      // cachea lo que se pide ANTES de tocar una API de request-time y no
      // cachea lo de después (ver `01-app/02-guides/caching-without-cache-components`).
      // O sea que la frescura de esta cotización dependería de en qué orden la
      // llamó quien la llamó — y una cotización cacheada devuelta como `ok`
      // sería justo la "última cotización conocida" que el bloque de arriba
      // promete que no existe. La decide este módulo, no el contexto.
      cache: "no-store",
    });
  } catch {
    // Red caída o timeout: no llegó a haber respuesta. Transitorio.
    return unreachable();
  }

  if (!response.ok) return unreachable();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Contestó, pero con algo que no es JSON. Eso ya es contrato roto.
    return badResponse();
  }

  const { venta, fechaActualizacion } = (body ?? {}) as {
    venta?: unknown;
    fechaActualizacion?: unknown;
  };

  if (typeof venta !== "number" || !Number.isFinite(venta)) {
    return badResponse();
  }
  // Positivo no alcanza: un `1` es positivo y no es una cotización.
  if (venta < MIN_PLAUSIBLE_RATE || venta > MAX_PLAUSIBLE_RATE) {
    return badResponse();
  }
  if (typeof fechaActualizacion !== "string") return badResponse();

  const quotedAt = new Date(fechaActualizacion);
  if (Number.isNaN(quotedAt.getTime())) return badResponse();

  // Que la fecha se pueda leer no quiere decir que sirva. Un servicio que se
  // quedó congelado devuelve una cotización de hace meses con formato
  // impecable, y esa tasa vieja se cobraría como si fuera de hoy. Se rechaza
  // por vieja y también por futura: una fecha adelantada no es un dato
  // conservador, es una señal de que del otro lado algo está mal.
  const ageMs = now.getTime() - quotedAt.getTime();
  if (ageMs > MAX_QUOTE_AGE_MS || ageMs < -MAX_CLOCK_SKEW_MS) {
    return badResponse();
  }

  return ok({ rate: venta, source: SOURCE, quotedAt });
}
