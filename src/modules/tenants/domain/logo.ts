/**
 * Reglas del logo del negocio.
 *
 * El logo termina en un bucket de LECTURA PÚBLICA, servido en una URL propia.
 * Eso cambia el problema: no alcanza con que el archivo "sea una imagen" para
 * la UI, tiene que ser inofensivo servido crudo a cualquiera que abra el link.
 */

/**
 * Tipos aceptados. SVG está afuera A PROPÓSITO.
 *
 * Un SVG no es un mapa de bits: es un documento XML que admite `<script>`.
 * Servido desde un bucket público, abrir su URL ejecuta ese script en nuestro
 * origen — XSS alojado por nosotros y firmado con el nombre del negocio. Es el
 * único formato de imagen común que además es un vector de ejecución, y por eso
 * es la única exclusión que no es por comodidad.
 */
export const ALLOWED_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AllowedLogoType = (typeof ALLOWED_LOGO_TYPES)[number];

/** 2 MB. Un logo que no entra en 2 MB no es un logo, es una foto. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Por qué se rechazó, para que la acción elija el mensaje. */
export type LogoRejection = "empty" | "size" | "type" | "content";

const EXTENSIONS: Record<AllowedLogoType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Extensión con la que se guarda cada tipo permitido. */
export function logoExtensionFor(type: string): string | null {
  return EXTENSIONS[type as AllowedLogoType] ?? null;
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

/**
 * Qué es el archivo SEGÚN SUS BYTES, o `null` si no es ninguno de los que
 * aceptamos.
 *
 * El `type` que manda el navegador es un dato del cliente: se elige, no se
 * deriva. Cualquiera puede subir HTML declarado `image/png`. Mirar la firma es
 * la diferencia entre creerle a la etiqueta y haber abierto el paquete.
 *
 * WEBP no tiene firma contigua: son cuatro bytes "RIFF", cuatro de longitud, y
 * recién en el offset 8 el marcador "WEBP". Mirar sólo los primeros cuatro
 * aceptaría un WAV, que también es RIFF.
 */
export function sniffImageType(bytes: Uint8Array): AllowedLogoType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_MARKER, 8)) {
    return "image/webp";
  }
  return null;
}

interface LogoCandidate {
  /** Tipo declarado por el cliente. No se le cree, se lo contrasta. */
  type: string;
  size: number;
  /** Primeros bytes del archivo: con 12 alcanza para las tres firmas. */
  head: Uint8Array;
}

/**
 * Motivo del rechazo, o `null` si el archivo sirve.
 *
 * Devuelve el motivo en vez de tirar porque el llamador es una Server Action
 * que tiene que traducirlo a un mensaje de formulario.
 *
 * El orden importa poco salvo en un punto: el contraste entre tipo declarado y
 * contenido real va ÚLTIMO, porque es el único chequeo que necesita haber leído
 * el archivo. Los baratos descartan antes de llegar ahí.
 */
export function rejectLogo({ type, size, head }: LogoCandidate): LogoRejection | null {
  if (size <= 0) return "empty";
  if (size > MAX_LOGO_BYTES) return "size";
  if (!ALLOWED_LOGO_TYPES.includes(type as AllowedLogoType)) return "type";

  // Etiqueta permitida, contenido que no la respalda: o es un archivo roto, o
  // alguien está probando qué pasa si miente.
  if (sniffImageType(head) !== type) return "content";

  return null;
}
