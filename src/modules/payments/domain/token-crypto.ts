import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { appError, err, ok, type Result } from "@/core/result";

/**
 * Cifrado de los tokens de Mercado Pago de cada negocio.
 *
 * Con el access token de un negocio se cobra a su nombre, y con el refresh
 * token se fabrican todos los que siguen. Guardarlos en claro dejaría a
 * cualquiera con lectura de la base (un backup, un dump, un log de consulta)
 * con acceso a la plata de todos los negocios, así que en la columna va un
 * sobre cifrado y la clave vive sólo en el entorno del servidor.
 *
 * AES-256-GCM porque autentica además de cifrar: un sobre tocado no descifra
 * a basura, falla. Eso es lo que permite distinguir "se rompió" de "lo
 * cambiaron".
 *
 * Forma del sobre: `v1.<iv>.<tag>.<ciphertext>`, todo en base64url. La versión
 * va adelante para poder rotar el algoritmo o la clave sin adivinar qué hay en
 * cada fila.
 *
 * Ningún mensaje de error incluye el texto plano ni la clave, y nada tira
 * hacia afuera: quien llama recibe un Result y decide.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
/** 96 bits: el largo que GCM está diseñado para usar. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

const invalidKey = () =>
  err(
    appError(
      "invalid_key",
      "La clave de cifrado de pagos no es válida: tiene que ser de 32 bytes en base64.",
    ),
  );

const malformed = () =>
  err(appError("malformed_envelope", "El token guardado tiene un formato inválido."));

/**
 * Convierte la clave de base64 a bytes, o `null` si no mide 32.
 *
 * `Buffer.from(x, "base64")` no tira ante texto inválido: descarta lo que no
 * entiende y devuelve menos bytes. Por eso se valida el largo DESPUÉS de
 * convertir y no el del texto.
 */
function parseKey(key: string): Buffer | null {
  if (typeof key !== "string") return null;
  const bytes = Buffer.from(key, "base64");
  return bytes.length === KEY_BYTES ? bytes : null;
}

export function encryptToken(plaintext: string, key: string): Result<string> {
  const keyBytes = parseKey(key);
  if (!keyBytes) return invalidKey();

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return ok(
      [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join("."),
    );
  } catch {
    // Sin `cause`: el error de crypto podría arrastrar material de la clave.
    return err(appError("encrypt_failed", "No se pudo cifrar el token."));
  }
}

export function decryptToken(envelope: string, key: string): Result<string> {
  const keyBytes = parseKey(key);
  if (!keyBytes) return invalidKey();

  if (typeof envelope !== "string") return malformed();
  const parts = envelope.split(".");
  if (parts.length !== 4) return malformed();

  const [version, ivText, tagText, ctText] = parts as [string, string, string, string];
  if (version !== VERSION) {
    return err(
      appError("unsupported_version", "El token guardado usa una versión de cifrado desconocida."),
    );
  }

  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ctText, "base64url");
  // Un tag más corto de lo debido haría que GCM acepte una verificación
  // truncada: se exige el largo exacto antes de tocar el decipher.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return malformed();

  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return ok(plaintext.toString("utf8"));
  } catch {
    return err(
      appError(
        "decrypt_failed",
        "No se pudo descifrar el token guardado: la clave no coincide o el dato fue alterado.",
      ),
    );
  }
}
