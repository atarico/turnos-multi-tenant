import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Lo que hace falta para decidir si una notificación es de Mercado Pago.
 *
 * El secreto y el reloj entran por parámetro y no se leen del entorno acá: así
 * esto queda como una función pura que se puede probar sin configurar nada y
 * sin depender de la hora a la que corre la suite. Quien la llama —el Route
 * Handler— es el único que toca el entorno.
 */
export interface WebhookSignatureInput {
  /** El header `x-signature`, con la forma `ts=<ts>,v1=<hash>`. */
  signatureHeader: string | null;
  /** El header `x-request-id`. */
  requestId: string | null;
  /** El query param `data.id` de la URL de la notificación. */
  dataId: string | null;
  secret: string;
  /** Contra qué momento se mide la frescura de la firma. */
  now: Date;
}

/** Un sha256 en hexadecimal ocupa 32 bytes. */
const SHA256_BYTES = 32;

/**
 * Cuánto vale una firma antes de vencer.
 *
 * SIN ESTO LA FIRMA NO VENCE NUNCA, y una notificación legítima capturada se
 * puede reproducir para siempre. El manifiesto incluye el `ts`, pero incluirlo
 * sólo lo ATA a la firma: hasta que alguien lo compare contra el reloj, el
 * único efecto es que no se lo puede cambiar sin invalidarla.
 *
 * Cinco minutos para cada lado. Hacia adelante cubre desfasaje de relojes;
 * hacia atrás es la ventana de reproducción, y se quiere lo más corta posible.
 *
 * OJO: si Mercado Pago reenvía la firma ORIGINAL en sus reintentos, en vez de
 * volver a firmar, esta ventana rechaza los reintentos legítimos y hay que
 * subirla. Es lo primero que hay que confirmar contra el sandbox. Se eligió
 * fallar por acá igual porque los dos fallos no son simétricos: una ventana
 * corta de más falla RUIDOSO —el dueño paga y no se le activa, se nota y se
 * arregla moviendo esta constante— y no tenerla falla en silencio.
 */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A partir de acá un `ts` se lee como milisegundos y no como segundos.
 *
 * La documentación de Mercado Pago se contradice sola: en un lado dice que el
 * `ts` viene en milisegundos y en otro muestra `ts=1704908010`, que son diez
 * dígitos, o sea segundos. Interpretar mal la unidad rompe la ventana entera —
 * con segundos leídos como milisegundos toda firma parece de 1970.
 *
 * Se decide por magnitud, que es inequívoco: un timestamp en segundos ronda
 * 1,7 mil millones y uno en milisegundos 1,7 billones. Entre los dos hay tres
 * órdenes de magnitud, así que el corte no se acerca a ninguno de los dos ni
 * en varios siglos.
 */
const MILLISECONDS_THRESHOLD = 1e11;

/**
 * Lee `ts` y `v1` de un header con la forma `ts=1755464280,v1=618c85...`.
 *
 * Tolera espacios alrededor de las comas y de los iguales porque la
 * documentación de Mercado Pago los muestra así, y rechazar una notificación
 * legítima por un espacio sería peor que aceptarla.
 *
 * Devuelve `null` ante cualquier cosa que no tenga las dos claves con valor.
 */
function parseSignatureHeader(
  header: string | null,
): { ts: string; v1: string } | null {
  if (!header) return null;

  let ts = "";
  let v1 = "";

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;

    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === "ts") ts = value;
    if (key === "v1") v1 = value;
  }

  if (!ts || !v1) return null;
  return { ts, v1 };
}

/**
 * ¿La firma se emitió hace poco?
 *
 * El `ts` llega como texto y puede ser cualquier cosa: se exige que sea un
 * entero positivo antes de tratarlo como un momento. `Number("12abc")` da
 * `NaN`, y un `NaN` en una comparación devuelve `false` siempre — o sea que
 * sin este chequeo una firma con `ts` basura pasaría por "no está vencida".
 */
function isFresh(ts: string, now: Date): boolean {
  if (!/^\d+$/.test(ts)) return false;

  const raw = Number(ts);
  if (!Number.isSafeInteger(raw) || raw <= 0) return false;

  const signedAtMs = raw >= MILLISECONDS_THRESHOLD ? raw : raw * 1000;
  const ageMs = now.getTime() - signedAtMs;

  return ageMs <= MAX_SIGNATURE_AGE_MS && ageMs >= -MAX_CLOCK_SKEW_MS;
}

/**
 * El texto que Mercado Pago firma.
 *
 * Las partes vacías se OMITEN, no se incluyen en blanco: `request-id:;ts:1;` no
 * es lo mismo que `ts:1;` y produce otro hash. Copiar la regla exacta es lo que
 * hace que las notificaciones que llegan sin `data.id` o sin `x-request-id`
 * validen en vez de rechazarse todas.
 *
 * El id del recurso va en minúsculas, que es como ellos lo firman.
 */
function buildManifest(
  dataId: string | null,
  requestId: string | null,
  ts: string,
): string {
  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId.toLowerCase()}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);

  return `${parts.join(";")};`;
}

/**
 * Compara dos hashes hexadecimales sin filtrar por dónde difieren.
 *
 * `timingSafeEqual` TIRA un RangeError si los buffers tienen largos distintos,
 * y un `v1` de largo arbitrario es justo lo primero que manda alguien probando
 * el endpoint. Sin este chequeo previo el portón devuelve 500 en vez de 401 — y
 * un 500 que se puede provocar a voluntad es una forma barata de tirar abajo el
 * webhook que confirma los cobros.
 *
 * `Buffer.from(x, "hex")` tampoco alcanza como validación: no tira ante texto
 * que no es hexadecimal, descarta lo que no puede leer y devuelve un buffer más
 * corto. Por eso se compara el largo DESPUÉS de convertir, contra el tamaño que
 * un sha256 tiene que ocupar.
 */
function hashesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");

  if (a.length !== SHA256_BYTES || b.length !== SHA256_BYTES) return false;

  return timingSafeEqual(a, b);
}

/**
 * ¿Esta notificación la mandó Mercado Pago, y la mandó recién?
 *
 * Es el único portón del proyecto abierto a internet: al Route Handler que la
 * usa le puede pegar cualquiera, y lo que hay del otro lado activa
 * suscripciones y rota períodos de cobro.
 *
 * FALLA CERRADO ante todo lo que no sea una firma que verifica Y está fresca:
 * header ausente, mal formado, hash de otro largo, secreto sin configurar, o
 * una firma vencida. No hay grados — o probó ser Mercado Pago recién o no.
 *
 * Y devuelve un booleano y no un `Result` a propósito. Quien llama sólo puede
 * hacer una cosa con un "no" —responder 401 y no tocar nada—, y un código de
 * error que distinga "header ausente" de "hash equivocado" le va contando a
 * quien prueba en qué paso lo frenaron.
 *
 * LAS DOS COSAS SON DISTINTAS, y hacen falta las dos. La firma ata el id del
 * recurso, el id de la request y el momento: cambiar cualquiera de los tres la
 * invalida, así que una notificación legítima capturada no se puede reapuntar a
 * otra suscripción. Pero atar el momento no es lo mismo que exigir que sea
 * reciente — sin la ventana de frescura, esa misma notificación capturada, sin
 * modificarle nada, sirve para siempre.
 */
export function isValidWebhookSignature(input: WebhookSignatureInput): boolean {
  // El tipo dice `string`, pero esto se alimenta del entorno y un tipo no
  // sobrevive al límite del proceso: una variable sin definir llega como
  // `undefined` y `undefined.trim()` TIRA. Una excepción acá convierte un 401
  // en un 500, que es la misma falla que `hashesMatch` se cuida de evitar diez
  // líneas más abajo. Un secreto sin configurar deja el portón CERRADO.
  if (typeof input.secret !== "string" || !input.secret.trim()) return false;

  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return false;

  // Antes del HMAC: una firma vencida no se salva por estar bien hecha, y
  // chequearlo primero evita gastar el cálculo.
  if (!isFresh(parsed.ts, input.now)) return false;

  const manifest = buildManifest(input.dataId, input.requestId, parsed.ts);
  const expected = createHmac("sha256", input.secret)
    .update(manifest)
    .digest("hex");

  return hashesMatch(expected, parsed.v1);
}

// ============================================================================
// TEMPORAL — SOLO DIAGNÓSTICO. BORRAR JUNTO CON EL LOGGING DE route.ts.
//
// El portón devuelve el mismo 401 con cuerpo vacío ante cualquier motivo, que
// es lo correcto de cara a afuera pero deja sin señal a quien integra. Esto
// existe para una sola pregunta: cuál de los pasos frena a las notificaciones
// del simulador de Mercado Pago.
//
// NO se registra el secreto. El manifiesto y un prefijo de hash no permiten
// reconstruirlo: para eso habría que invertir un HMAC-SHA256.
// ============================================================================

/** Lo que se pudo observar de un intento de verificación, paso por paso. */
export interface WebhookSignatureDiagnosis {
  hasSecret: boolean;
  headerParsed: boolean;
  ts: string | null;
  /** Cuántos segundos pasaron desde que se firmó. Negativo = firma futura. */
  ageSeconds: number | null;
  fresh: boolean;
  hasDataId: boolean;
  hasRequestId: boolean;
  manifest: string | null;
  expectedPrefix: string | null;
  receivedPrefix: string | null;
  matches: boolean;
  /**
   * Si alguno de los ids alternativos produce una firma válida, cuál.
   *
   * Es la pregunta concreta del candidato 2: el simulador no manda `data.id`
   * en el query string, y si Mercado Pago igual lo firmó, el id está en el
   * cuerpo. Que acá aparezca un valor ES el diagnóstico.
   */
  matchingAlternateId: string | null;
}

/** Los primeros ocho caracteres de un hash. Suficiente para comparar a ojo. */
const PREFIX_LENGTH = 8;

export function diagnoseWebhookSignature(
  input: WebhookSignatureInput,
  alternateDataIds: readonly string[] = [],
): WebhookSignatureDiagnosis {
  const base: WebhookSignatureDiagnosis = {
    hasSecret: typeof input.secret === "string" && input.secret.trim() !== "",
    headerParsed: false,
    ts: null,
    ageSeconds: null,
    fresh: false,
    hasDataId: Boolean(input.dataId),
    hasRequestId: Boolean(input.requestId),
    manifest: null,
    expectedPrefix: null,
    receivedPrefix: null,
    matches: false,
    matchingAlternateId: null,
  };

  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return base;

  const rawTs = Number(parsed.ts);
  const signedAtMs = /^\d+$/.test(parsed.ts)
    ? rawTs >= MILLISECONDS_THRESHOLD
      ? rawTs
      : rawTs * 1000
    : null;

  const diagnosis: WebhookSignatureDiagnosis = {
    ...base,
    headerParsed: true,
    ts: parsed.ts,
    ageSeconds:
      signedAtMs === null
        ? null
        : Math.round((input.now.getTime() - signedAtMs) / 1000),
    fresh: isFresh(parsed.ts, input.now),
    receivedPrefix: parsed.v1.slice(0, PREFIX_LENGTH),
  };

  if (!base.hasSecret) return diagnosis;

  const hashFor = (dataId: string | null) => {
    const manifest = buildManifest(dataId, input.requestId, parsed.ts);
    const expected = createHmac("sha256", input.secret)
      .update(manifest)
      .digest("hex");
    return { manifest, expected };
  };

  const primary = hashFor(input.dataId);

  // Se prueban los ids alternativos aunque el principal haya coincidido: si dos
  // coinciden, el manifiesto no es lo que está mal y hay que mirar otra cosa.
  const matchingAlternateId =
    alternateDataIds.find((candidate) =>
      hashesMatch(hashFor(candidate).expected, parsed.v1),
    ) ?? null;

  return {
    ...diagnosis,
    manifest: primary.manifest,
    expectedPrefix: primary.expected.slice(0, PREFIX_LENGTH),
    matches: hashesMatch(primary.expected, parsed.v1),
    matchingAlternateId,
  };
}
