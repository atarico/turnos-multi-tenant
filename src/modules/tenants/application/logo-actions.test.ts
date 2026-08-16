import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import { removeLogoAction, uploadLogoAction } from "./logo-actions";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

/**
 * Los dobles se tipan por GENÉRICO (`vi.fn<Firma>`) en vez de declarar
 * parámetros en la implementación.
 *
 * Hace falta una firma porque estos tests inspeccionan los argumentos —la ruta
 * bajo la que se guarda, lo que se escribe en la fila, lo que se borra— y sin
 * ella `mock.calls[0][0]` es un elemento de una tupla vacía que TypeScript
 * rechaza. Declararlos en la implementación los dejaría sin usar, y este repo
 * no configura excepción para el prefijo `_`. Es el mismo idioma que
 * `staff-form.test.tsx`.
 */

// --- doble de la tabla `tenants` -------------------------------------------
let updateError: { message: string } | null = null;
let updatedRows: Array<{ id: string }> = [{ id: "tenant-1" }];

const select = vi.fn<
  (columns: string) => Promise<{
    data: Array<{ id: string }>;
    error: { message: string } | null;
  }>
>(async () => ({ data: updatedRows, error: updateError }));

/**
 * El UPDATE encadena DOS condiciones: el id del negocio, y —para el
 * compare-and-swap— el logo que la acción leyó. Por eso `eq` se devuelve a sí
 * mismo, y `is` existe: sin logo previo la condición es IS NULL, porque en SQL
 * nada es igual a null.
 */
interface Filters {
  eq: typeof eq;
  is: typeof is;
  select: typeof select;
}
const eq = vi.fn<(column: string, value: string | null) => Filters>(
  () => filters,
);
const is = vi.fn<(column: string, value: null) => Filters>(() => filters);
const filters: Filters = { eq, is, select } as Filters;
const update = vi.fn<(values: Record<string, unknown>) => Filters>(() => filters);
const from = vi.fn<(table: string) => { update: typeof update }>(() => ({
  update,
}));

// --- doble de Storage -------------------------------------------------------
let uploadError: { message: string } | null = null;
const upload = vi.fn<
  (
    path: string,
    file: File,
    options?: unknown,
  ) => Promise<{ error: { message: string } | null }>
>(async () => ({ error: uploadError }));

const getPublicUrl = vi.fn((path: string) => ({
  data: { publicUrl: `https://cdn.test/storage/${path}` },
}));

const remove = vi.fn<(paths: string[]) => Promise<{ error: null }>>(async () => ({
  error: null,
}));

const storageFrom = vi.fn<
  (bucket: string) => {
    upload: typeof upload;
    getPublicUrl: typeof getPublicUrl;
    remove: typeof remove;
  }
>(() => ({ upload, getPublicUrl, remove }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from, storage: { from: storageFrom } }),
}));

const tenantStub = {
  id: "tenant-1",
  slug: "peluqueria-acme",
  logo_url: null as string | null,
};
const getCurrentTenant = vi.fn(async () => tenantStub as unknown);
vi.mock("./queries", () => ({
  getCurrentTenant: () => getCurrentTenant(),
}));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HTML = [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45];

function logoForm(
  head: number[] = PNG,
  type = "image/png",
  totalBytes = 1024,
): FormData {
  const buf = new Uint8Array(totalBytes);
  buf.set(head);
  const form = new FormData();
  form.append("logo", new File([buf], "logo", { type }));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateError = null;
  updatedRows = [{ id: "tenant-1" }];
  uploadError = null;
  getCurrentTenant.mockResolvedValue(tenantStub);
});

describe("uploadLogoAction", () => {
  /**
   * Los tres rechazos que importan comparten una exigencia: que Storage NO se
   * toque. Un archivo peligroso que llega al bucket ya está servido en una URL
   * pública aunque después falle el resto — rechazar tarde no es rechazar.
   */
  it("rechaza un SVG sin subir nada", async () => {
    const result = await uploadLogoAction(
      idleState,
      logoForm([0x3c, 0x73, 0x76, 0x67], "image/svg+xml"),
    );

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  // El caso que justifica leer los bytes: la etiqueta es válida, el contenido no.
  it("rechaza HTML disfrazado de PNG sin subir nada", async () => {
    const result = await uploadLogoAction(idleState, logoForm(HTML, "image/png"));

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("rechaza un archivo más grande que el límite sin subir nada", async () => {
    const result = await uploadLogoAction(
      idleState,
      logoForm(PNG, "image/png", 2 * 1024 * 1024 + 1),
    );

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it("rechaza cuando no vino ningún archivo", async () => {
    const result = await uploadLogoAction(idleState, new FormData());

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
  });

  /**
   * La ruta ES la autorización: la política de Storage sólo puede mirar el
   * primer segmento del path. Si el archivo se guardara fuera de la carpeta del
   * negocio, la política lo rechazaría — o peor, lo aceptaría en la carpeta de
   * otro.
   */
  it("guarda el archivo dentro de la carpeta del negocio", async () => {
    await uploadLogoAction(idleState, logoForm());

    expect(storageFrom).toHaveBeenCalledWith("tenant-logos");
    const path = upload.mock.calls[0]![0];
    expect(path.startsWith("tenant-1/")).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
  });

  it("guarda la URL pública en el negocio y revalida las dos pantallas", async () => {
    const result = await uploadLogoAction(idleState, logoForm());

    expect(result.status).toBe("success");
    const savedUrl = update.mock.calls[0]![0].logo_url as string;
    expect(savedUrl).toContain("https://cdn.test/storage/tenant-1/");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/configuracion");
    expect(revalidatePath).toHaveBeenCalledWith("/peluqueria-acme");
  });

  it("no dice que guardó si la subida falló", async () => {
    uploadError = { message: "boom" };

    const result = await uploadLogoAction(idleState, logoForm());

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * La misma lección que el color: PostgREST devuelve `error: null` cuando RLS
   * recorta el UPDATE a cero filas. Acá duele más, porque el archivo YA está
   * subido: decir "listo" dejaría un logo en el bucket que la fila no apunta.
   */
  it("no dice que guardó si la fila no se actualizó", async () => {
    updatedRows = [];

    const result = await uploadLogoAction(idleState, logoForm());

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * Cuando la fila no se actualiza, el archivo YA está en el bucket. Sin
   * deshacer esa subida queda un objeto que nadie apunta y que nadie va a
   * juntar nunca — y se acumula uno por cada reintento fallido.
   *
   * Esto lo perdí yo al sacar el barrido de carpeta: aquel, con todos sus
   * problemas de concurrencia, al menos limpiaba los huérfanos. Reemplazarlo
   * por un borrado puntual dejó la fuga sin tapar hasta que el review la marcó.
   */
  it("deshace la subida cuando la fila no se pudo actualizar", async () => {
    updatedRows = [];

    await uploadLogoAction(idleState, logoForm());

    const subido = upload.mock.calls[0]![0];
    expect(remove).toHaveBeenCalledWith([subido]);
  });

  it("deshace la subida cuando el guardado devuelve error", async () => {
    updateError = { message: "boom" };

    await uploadLogoAction(idleState, logoForm());

    const subido = upload.mock.calls[0]![0];
    expect(remove).toHaveBeenCalledWith([subido]);
  });

  // El logo anterior NO se toca si el guardado falló: la fila lo sigue
  // apuntando, así que borrarlo dejaría al negocio sin logo por un error que
  // no tuvo nada que ver con él.
  it("no toca el logo anterior si el guardado falló", async () => {
    updatedRows = [];
    getCurrentTenant.mockResolvedValue({
      ...tenantStub,
      logo_url:
        "https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/viejo.png",
    });

    await uploadLogoAction(idleState, logoForm());

    const borrados = remove.mock.calls.flatMap((call) => call[0]);
    expect(borrados).not.toContain("tenant-1/viejo.png");
  });

  /**
   * La combinación que el review marcó como no cubierta: una subida y un
   * borrado del mismo negocio corriendo a la vez. Ninguno puede dejar la
   * columna apuntando a un archivo que el otro borró.
   */
  it("una subida y un borrado simultáneos no se dejan una referencia colgada", async () => {
    const previo =
      "https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/viejo.png";
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: previo });

    await Promise.all([
      uploadLogoAction(idleState, logoForm()),
      removeLogoAction(),
    ]);

    const subido = upload.mock.calls[0]![0];
    const borrados = remove.mock.calls.flatMap((call) => call[0]);

    // Los dos apuntan al MISMO archivo viejo. El recién subido no se toca.
    expect(borrados.every((p) => p === "tenant-1/viejo.png")).toBe(true);
    expect(borrados).not.toContain(subido);
  });

  it("borra el logo anterior, identificado por su URL", async () => {
    getCurrentTenant.mockResolvedValue({
      ...tenantStub,
      logo_url: `https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/viejo.png`,
    });

    await uploadLogoAction(idleState, logoForm());

    expect(remove).toHaveBeenCalledWith(["tenant-1/viejo.png"]);
  });

  it("no intenta borrar nada cuando no había logo previo", async () => {
    await uploadLogoAction(idleState, logoForm());

    expect(remove).not.toHaveBeenCalled();
  });

  /**
   * El bug que encontró el review, pinchado como test.
   *
   * Antes esto listaba la carpeta y borraba "todo menos lo mío". Con dos
   * subidas simultáneas del mismo negocio, la que terminaba última se llevaba
   * el archivo que la columna estaba apuntando y la página pública quedaba con
   * una imagen rota.
   *
   * Ahora cada subida borra sólo el archivo que ELLA reemplazó. Se simula la
   * carrera corriendo dos subidas que leyeron el mismo logo previo: ninguna de
   * las dos puede tocar el archivo de la otra.
   */
  /**
   * La escritura es un COMPARE-AND-SWAP: sólo pisa la fila si sigue apuntando
   * al logo que esta acción leyó. Sin esa condición, dos subidas concurrentes
   * escriben las dos, gana la última, y el archivo de la que perdió queda sin
   * que nadie lo apunte ni lo borre nunca.
   */
  it("condiciona la escritura al logo que leyó", async () => {
    const previo =
      "https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/viejo.png";
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: previo });

    await uploadLogoAction(idleState, logoForm());

    expect(eq).toHaveBeenCalledWith("logo_url", previo);
  });

  // Sin logo previo la condición es IS NULL, no `= null`: en SQL nada es igual
  // a null, así que un `.eq` no matchearía nunca y toda primera subida fallaría.
  it("condiciona con IS NULL cuando el negocio no tenía logo", async () => {
    await uploadLogoAction(idleState, logoForm());

    expect(is).toHaveBeenCalledWith("logo_url", null);
    expect(eq).not.toHaveBeenCalledWith("logo_url", null);
  });

  /**
   * El que pierde la carrera se entera de que perdió —su UPDATE condicional no
   * toca ninguna fila— y limpia SU PROPIO archivo antes de devolver el error.
   * Ese es el punto: sin CAS el perdedor creía haber ganado y dejaba basura que
   * nadie iba a juntar.
   */
  it("el que pierde la carrera borra su propio archivo y avisa", async () => {
    updatedRows = [];

    const result = await uploadLogoAction(idleState, logoForm());

    expect(result.status).toBe("error");
    const subido = upload.mock.calls[0]![0];
    expect(remove).toHaveBeenCalledWith([subido]);
  });

  it("con dos subidas simultáneas, ninguna borra el archivo de la otra", async () => {
    const previo =
      "https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/viejo.png";
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: previo });

    await Promise.all([
      uploadLogoAction(idleState, logoForm()),
      uploadLogoAction(idleState, logoForm()),
    ]);

    const subidos = upload.mock.calls.map((call) => call[0]);
    const borrados = remove.mock.calls.flatMap((call) => call[0]);

    for (const subido of subidos) {
      expect(borrados).not.toContain(subido);
    }
  });

  it("falla sin tocar nada cuando el usuario no tiene negocio", async () => {
    getCurrentTenant.mockResolvedValue(null);

    const result = await uploadLogoAction(idleState, logoForm());

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
  });
});

describe("removeLogoAction", () => {
  it("vacía la columna y borra el archivo que estaba guardado", async () => {
    getCurrentTenant.mockResolvedValue({
      ...tenantStub,
      logo_url:
        "https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/actual.png",
    });

    const result = await removeLogoAction();

    expect(result.status).toBe("success");
    expect(update).toHaveBeenCalledWith({ logo_url: null });
    expect(remove).toHaveBeenCalledWith(["tenant-1/actual.png"]);
    expect(revalidatePath).toHaveBeenCalledWith("/peluqueria-acme");
  });

  it("no dice que borró si la fila no se actualizó", async () => {
    updatedRows = [];

    const result = await removeLogoAction();

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
