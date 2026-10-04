import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { appError, err, ok, type Result } from "@/core/result";

/**
 * Piezas puras del flujo OAuth de Mercado Pago: PKCE, `state` firmado, URL de
 * autorización y vencimiento de tokens. El reloj, el azar y los secretos entran
 * por parámetro: nada acá lee el entorno, así que se prueba sin configurar nada.
 */

// ---------------------------------------------------------------- PKCE

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Par PKCE (RFC 7636, método S256).
 *
 * 32 bytes aleatorios dan un verifier de 43 caracteres base64url, que es el
 * mínimo que pide el RFC y alcanza de sobra. `randomBytes` es inyectable para
 * poder probar contra el vector del apéndice B.
 */
export function createPkcePair(
  random: (size: number) => Buffer = randomBytes,
): PkcePair {
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// --------------------------------------------------------------- state

export interface OAuthState {
  tenantId: string;
  nonce: string;
  issuedAt: Date;
}

/** Cuánto vive un `state` desde que se firma: lo que tarda una persona en autorizar. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Tolerancia a relojes desfasados entre instancias; más allá es un `state` del futuro. */
const STATE_CLOCK_SKEW_MS = 60 * 1000;

const mac = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest();

/**
 * Firma el `state`: `<payload base64url>.<hmac base64url>`.
 *
 * El `state` ata el callback al negocio que inició la conexión; sin firma,
 * quien conozca el callback podría conectar SU cuenta de Mercado Pago a un
 * negocio ajeno. Un secreto vacío tira: firmar con "" produce una firma que
 * cualquiera reproduce, y eso es un error de configuración, no un caso a tolerar.
 */
export function signState(state: OAuthState, secret: string): string {
  if (!secret) throw new Error("signState: secreto vacío");

  const body = Buffer.from(
    JSON.stringify({ t: state.tenantId, n: state.nonce, i: state.issuedAt.getTime() }),
  ).toString("base64url");

  return `${body}.${mac(body, secret).toString("base64url")}`;
}

const stateError = (code: string, message: string) => err(appError(code, message));

/**
 * Verifica firma y vigencia de un `state`.
 *
 * Códigos distintos para que el callback pueda decirle algo útil al dueño:
 * `state_malformed` (no es un state nuestro), `state_invalid` (la firma no
 * coincide o viene del futuro) y `state_expired` (firma buena, pero tardó más
 * de 10 minutos). La firma se chequea ANTES que el vencimiento: un state
 * adulterado no debe poder reportarse como "vencido".
 */
export function verifyState(
  state: string,
  secret: string,
  now: Date,
): Result<OAuthState> {
  const malformed = () =>
    stateError("state_malformed", "El enlace de conexión no es válido. Empezá de nuevo.");

  if (typeof state !== "string") return malformed();
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return malformed();
  const [body, signature] = parts as [string, string];

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return malformed();
  }
  const { t, n, i } = (payload ?? {}) as { t?: unknown; n?: unknown; i?: unknown };
  if (typeof t !== "string" || typeof n !== "string" || typeof i !== "number" || !Number.isFinite(i)) {
    return malformed();
  }

  const invalid = () =>
    stateError("state_invalid", "El enlace de conexión no pasó la verificación. Empezá de nuevo.");

  if (!secret) return invalid();
  const expected = mac(body, secret);
  const received = Buffer.from(signature, "base64url");
  // `timingSafeEqual` tira con largos distintos: se compara el largo primero.
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    return invalid();
  }

  const ageMs = now.getTime() - i;
  if (ageMs < -STATE_CLOCK_SKEW_MS) return invalid();
  if (ageMs > STATE_TTL_MS) {
    return stateError("state_expired", "El enlace de conexión venció. Empezá de nuevo.");
  }

  return ok({ tenantId: t, nonce: n, issuedAt: new Date(i) });
}

// ------------------------------------------------------ authorization

const AUTHORIZATION_ENDPOINT = "https://auth.mercadopago.com/authorization";

export interface AuthorizationUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("platform_id", "mp");
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ------------------------------------------------------------- vencimiento

/** Con cuánta anticipación se renueva: el access token dura unos 180 días. */
const REFRESH_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

export function tokenExpiresAt(now: Date, expiresInSeconds: number): Date {
  return new Date(now.getTime() + expiresInSeconds * 1000);
}

/** ¿Faltan menos de 30 días (o ya venció)? Exactamente 30 días todavía no. */
export function needsRefresh(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() < REFRESH_LEAD_MS;
}
