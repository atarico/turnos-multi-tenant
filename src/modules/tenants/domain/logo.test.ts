import { describe, expect, it } from "vitest";

import {
  ALLOWED_LOGO_TYPES,
  LOGO_BUCKET,
  MAX_LOGO_BYTES,
  logoExtensionFor,
  logoStoragePath,
  rejectLogo,
  sniffImageType,
} from "./logo";

/** Bytes de cabecera reales de cada formato, que es lo único que se mira. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const HTML = [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45];
const SVG = [0x3c, 0x73, 0x76, 0x67, 0x20];

const bytes = (head: number[], total = head.length) => {
  const buf = new Uint8Array(total);
  buf.set(head);
  return buf;
};

/**
 * El tipo declarado por el cliente es un DATO DEL ATACANTE, no una descripción.
 * Cualquiera puede mandar un `Content-Type: image/png` con HTML adentro. Como
 * el bucket es de lectura pública, ese archivo queda servido en una URL: si el
 * navegador lo interpretara como HTML, sería XSS alojado en nuestra
 * infraestructura y firmado con el nombre del negocio.
 *
 * Por eso se miran los BYTES. Es la diferencia entre creerle a la etiqueta y
 * haber mirado adentro.
 */
describe("sniffImageType", () => {
  it("reconoce PNG por su firma", () => {
    expect(sniffImageType(bytes(PNG))).toBe("image/png");
  });

  it("reconoce JPEG por su firma", () => {
    expect(sniffImageType(bytes(JPEG))).toBe("image/jpeg");
  });

  // WEBP no tiene una firma contigua: es "RIFF", cuatro bytes de tamaño, y
  // recién ahí "WEBP". Mirar sólo los primeros cuatro confundiría un WAV.
  it("reconoce WEBP mirando RIFF y el marcador que viene después del tamaño", () => {
    expect(sniffImageType(bytes(WEBP))).toBe("image/webp");
  });

  it("no confunde un RIFF que no es WEBP", () => {
    const wav = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];
    expect(sniffImageType(bytes(wav))).toBeNull();
  });

  it.each([
    ["GIF", GIF],
    ["HTML", HTML],
    ["SVG", SVG],
  ])("rechaza %s aunque venga etiquetado como imagen", (_label, head) => {
    expect(sniffImageType(bytes(head))).toBeNull();
  });

  it("no explota con un archivo más corto que cualquier firma", () => {
    expect(sniffImageType(new Uint8Array([0x89]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("rejectLogo", () => {
  const ok = { type: "image/png", size: 1024, head: bytes(PNG) };

  it("acepta un PNG dentro del límite", () => {
    expect(rejectLogo(ok)).toBeNull();
  });

  it("acepta exactamente el límite de tamaño", () => {
    expect(rejectLogo({ ...ok, size: MAX_LOGO_BYTES })).toBeNull();
  });

  it("rechaza un byte por encima del límite", () => {
    expect(rejectLogo({ ...ok, size: MAX_LOGO_BYTES + 1 })).toBe("size");
  });

  it("rechaza un archivo vacío", () => {
    expect(rejectLogo({ ...ok, size: 0 })).toBe("empty");
  });

  /**
   * SVG queda afuera A PROPÓSITO, y no por falta de ganas de soportarlo: un SVG
   * es un documento XML que admite `<script>`. Servido desde un bucket público,
   * abrir su URL ejecuta ese script en nuestro origen. Es el único formato de
   * imagen común que es también un vector de ejecución.
   */
  it("rechaza SVG por tipo declarado", () => {
    expect(rejectLogo({ ...ok, type: "image/svg+xml" })).toBe("type");
  });

  it.each(["image/gif", "application/pdf", "text/html", ""])(
    "rechaza el tipo no permitido %s",
    (type) => {
      expect(rejectLogo({ ...ok, type })).toBe("type");
    },
  );

  // El caso que justifica todo el sniffing: etiqueta válida, contenido que no.
  it("rechaza HTML disfrazado de PNG", () => {
    expect(rejectLogo({ ...ok, head: bytes(HTML) })).toBe("content");
  });

  it("rechaza un PNG declarado que en realidad es JPEG", () => {
    expect(rejectLogo({ ...ok, head: bytes(JPEG) })).toBe("content");
  });

  it("acepta los tres tipos permitidos con su contenido real", () => {
    expect(rejectLogo({ type: "image/png", size: 10, head: bytes(PNG) })).toBeNull();
    expect(rejectLogo({ type: "image/jpeg", size: 10, head: bytes(JPEG) })).toBeNull();
    expect(rejectLogo({ type: "image/webp", size: 10, head: bytes(WEBP) })).toBeNull();
  });
});

/**
 * Para reemplazar un logo hay que borrar el ANTERIOR, y lo único que se guarda
 * de él es su URL pública. Volver de la URL a la ruta del objeto es lo que
 * permite borrar exactamente ese archivo — en vez de barrer la carpeta, que es
 * lo que rompía con dos subidas simultáneas.
 */
describe("logoStoragePath", () => {
  const url = (path: string) =>
    `https://abc123.supabase.co/storage/v1/object/public/${LOGO_BUCKET}/${path}`;

  it("saca la ruta del objeto de su URL pública", () => {
    expect(logoStoragePath(url("t1/abcd.png"), "t1")).toBe("t1/abcd.png");
  });

  it("devuelve null si no hay logo guardado", () => {
    expect(logoStoragePath(null, "t1")).toBeNull();
  });

  /**
   * El chequeo que importa: la URL viene de una columna, y una columna se puede
   * escribir. Si apuntara a la carpeta de OTRO negocio, esto devolvería esa
   * ruta y el borrado intentaría llevarse un archivo ajeno. La política de
   * Storage lo frenaría igual, pero el pedido no debería salir nunca.
   */
  it("devuelve null si la ruta es de otro negocio", () => {
    expect(logoStoragePath(url("otro-tenant/abcd.png"), "t1")).toBeNull();
  });

  it("devuelve null si la URL no es de este bucket", () => {
    expect(
      logoStoragePath(
        "https://abc123.supabase.co/storage/v1/object/public/otra-cosa/t1/x.png",
        "t1",
      ),
    ).toBeNull();
  });

  // Un prefijo que sólo COMPARTE el comienzo del id no es el mismo negocio.
  it("no confunde un id que empieza igual", () => {
    expect(logoStoragePath(url("t10/abcd.png"), "t1")).toBeNull();
  });

  it.each(["", "no-es-una-url", "https://otro.host/x.png"])(
    "devuelve null ante %s",
    (raw) => {
      expect(logoStoragePath(raw, "t1")).toBeNull();
    },
  );
});

describe("logoExtensionFor", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ])("%s guarda como .%s", (type, extension) => {
    expect(logoExtensionFor(type)).toBe(extension);
  });

  it("cubre todos los tipos permitidos, sin agujeros", () => {
    for (const type of ALLOWED_LOGO_TYPES) {
      expect(logoExtensionFor(type)).toBeTruthy();
    }
  });
});
