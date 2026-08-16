import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import { saveSettingsAction } from "./settings-actions";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

// --- doble de la tabla `tenants` -------------------------------------------
let updateError: { message: string } | null = null;
let updatedRows: Array<{ id: string }> = [{ id: "tenant-1" }];

const select = vi.fn<
  (columns: string) => Promise<{
    data: Array<{ id: string }>;
    error: { message: string } | null;
  }>
>(async () => ({ data: updatedRows, error: updateError }));

interface Filters {
  eq: typeof eq;
  is: typeof is;
  select: typeof select;
}
const eq = vi.fn<(column: string, value: string | null) => Filters>(() => filters);
const is = vi.fn<(column: string, value: null) => Filters>(() => filters);
const filters: Filters = { eq, is, select } as Filters;
const update = vi.fn<(values: Record<string, unknown>) => Filters>(() => filters);
const from = vi.fn<(table: string) => { update: typeof update }>(() => ({ update }));

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
  data: {
    publicUrl: `https://cdn.test/storage/v1/object/public/tenant-logos/${path}`,
  },
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

const VIEJO =
  "https://cdn.test/storage/v1/object/public/tenant-logos/tenant-1/viejo.png";

const tenantStub = {
  id: "tenant-1",
  slug: "peluqueria-acme",
  logo_url: null as string | null,
};
const getCurrentTenant = vi.fn(async () => tenantStub as unknown);
vi.mock("./queries", () => ({ getCurrentTenant: () => getCurrentTenant() }));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HTML = [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45];

/** Un submit de la pantalla: siempre trae el color, opcionalmente lo demás. */
function form(options: {
  brandColor?: string;
  logo?: { head?: number[]; type?: string; bytes?: number };
  removeLogo?: boolean;
} = {}): FormData {
  const data = new FormData();
  data.append("brandColor", options.brandColor ?? "#6366f1");
  if (options.logo) {
    const buf = new Uint8Array(options.logo.bytes ?? 1024);
    buf.set(options.logo.head ?? PNG);
    data.append("logo", new File([buf], "logo", { type: options.logo.type ?? "image/png" }));
  }
  if (options.removeLogo) data.append("removeLogo", "on");
  return data;
}

const writtenValues = () =>
  update.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  updateError = null;
  updatedRows = [{ id: "tenant-1" }];
  uploadError = null;
  getCurrentTenant.mockResolvedValue(tenantStub);
});

describe("saveSettingsAction", () => {
  /**
   * La razón de ser de este cambio: un botón, una escritura.
   *
   * Antes el color y el logo eran dos acciones con dos escrituras, y podían
   * quedar a medias — el color guardado, el logo no, sin que nada lo dijera.
   * Con una sola fila escrita, o entran los dos o no entra ninguno.
   */
  it("guarda color y logo en UNA sola escritura", async () => {
    const result = await saveSettingsAction(
      idleState,
      form({ brandColor: "#aabbcc", logo: {} }),
    );

    expect(result.status).toBe("success");
    expect(update).toHaveBeenCalledTimes(1);
    const values = writtenValues();
    expect(values.brand_color).toBe("#aabbcc");
    expect(values.logo_url).toContain("tenant-logos/tenant-1/");
  });

  it("guarda sólo el color cuando no se tocó el logo", async () => {
    await saveSettingsAction(idleState, form({ brandColor: "#123456" }));

    expect(writtenValues()).toEqual({ brand_color: "#123456" });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  // Pedir sacar el logo es una intención explícita, distinta de "no lo toqué".
  it("vacía el logo cuando se pidió sacarlo", async () => {
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ removeLogo: true }));

    expect(writtenValues().logo_url).toBeNull();
    expect(remove).toHaveBeenCalledWith(["tenant-1/viejo.png"]);
  });

  // Reemplazar un logo tiene que llevarse el anterior: si no, cada cambio de
  // logo deja el archivo viejo ocupando lugar sin que nadie lo apunte.
  it("borra el logo anterior al reemplazarlo por uno nuevo", async () => {
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ logo: {} }));

    expect(remove).toHaveBeenCalledWith(["tenant-1/viejo.png"]);
  });

  it("no intenta borrar nada cuando no había logo previo", async () => {
    await saveSettingsAction(idleState, form({ logo: {} }));

    expect(remove).not.toHaveBeenCalled();
  });

  // Guardar sólo el color no debe tocar el archivo del logo por accidente.
  it("no toca el archivo del logo cuando sólo cambia el color", async () => {
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ brandColor: "#123456" }));

    expect(remove).not.toHaveBeenCalled();
    expect(writtenValues()).not.toHaveProperty("logo_url");
  });

  /**
   * Un archivo nuevo GANA sobre el pedido de sacarlo. La casilla de "sacar"
   * sólo aparece cuando no hay archivo elegido, así que llegar con las dos
   * cosas significa que el usuario eligió un archivo DESPUÉS de tildarla.
   */
  it("si vienen archivo y pedido de borrado, gana el archivo", async () => {
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ logo: {}, removeLogo: true }));

    expect(writtenValues().logo_url).toContain("tenant-logos/tenant-1/");
  });

  /**
   * El precio de tener un solo botón, y es deliberado: si el archivo no sirve,
   * NO se guarda nada — tampoco el color. Guardar la mitad de lo que el usuario
   * pidió, sin decírselo, es peor que fallar de frente.
   */
  it("con un archivo inválido no guarda NADA, ni el color", async () => {
    const result = await saveSettingsAction(
      idleState,
      form({ brandColor: "#aabbcc", logo: { type: "image/svg+xml", head: [0x3c, 0x73, 0x76, 0x67] } }),
    );

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  /**
   * El color termina inyectado como valor CSS en la página pública, así que un
   * valor que cierra una declaración y abre otra tiene que morir ACÁ, antes de
   * la base. La lista blanca del dominio lo cubre; esto verifica que la acción
   * efectivamente la consulta y no escribe igual.
   */
  it("no guarda un color que trae CSS de contrabando", async () => {
    const result = await saveSettingsAction(
      idleState,
      form({ brandColor: "#6366f1;}html{display:none" }),
    );

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });

  it("con HTML disfrazado de PNG tampoco guarda el color", async () => {
    const result = await saveSettingsAction(
      idleState,
      form({ brandColor: "#aabbcc", logo: { head: HTML } }),
    );

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });

  it("con un color inválido no sube el archivo", async () => {
    const result = await saveSettingsAction(
      idleState,
      form({ brandColor: "rojo", logo: {} }),
    );

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
  });

  /**
   * Compare-and-swap SÓLO cuando el logo cambia. Si únicamente cambia el color
   * no hay archivo que pueda quedar huérfano, así que condicionar la escritura
   * ahí sería hacerla fallar por una carrera que no tiene consecuencia.
   */
  it("condiciona la escritura al logo previo cuando sube uno nuevo", async () => {
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ logo: {} }));

    expect(eq).toHaveBeenCalledWith("logo_url", VIEJO);
  });

  it("usa IS NULL cuando el negocio todavía no tenía logo", async () => {
    await saveSettingsAction(idleState, form({ logo: {} }));

    expect(is).toHaveBeenCalledWith("logo_url", null);
    expect(eq).not.toHaveBeenCalledWith("logo_url", null);
  });

  it("no condiciona por logo cuando sólo cambia el color", async () => {
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ brandColor: "#123456" }));

    expect(eq).not.toHaveBeenCalledWith("logo_url", VIEJO);
    expect(is).not.toHaveBeenCalled();
  });

  it("deshace la subida si la escritura no tocó ninguna fila", async () => {
    updatedRows = [];

    const result = await saveSettingsAction(idleState, form({ logo: {} }));

    expect(result.status).toBe("error");
    const subido = upload.mock.calls[0]![0];
    expect(remove).toHaveBeenCalledWith([subido]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("no borra el logo anterior si la escritura falló", async () => {
    updatedRows = [];
    getCurrentTenant.mockResolvedValue({ ...tenantStub, logo_url: VIEJO });

    await saveSettingsAction(idleState, form({ logo: {} }));

    const borrados = remove.mock.calls.flatMap((call) => call[0]);
    expect(borrados).not.toContain("tenant-1/viejo.png");
  });

  it("no escribe la fila si la subida falló", async () => {
    uploadError = { message: "boom" };

    const result = await saveSettingsAction(idleState, form({ logo: {} }));

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });

  it("revalida el panel y la página pública al guardar", async () => {
    await saveSettingsAction(idleState, form({ brandColor: "#123456" }));

    expect(revalidatePath).toHaveBeenCalledWith("/panel/configuracion");
    expect(revalidatePath).toHaveBeenCalledWith("/peluqueria-acme");
  });

  it("falla sin tocar nada cuando el usuario no tiene negocio", async () => {
    getCurrentTenant.mockResolvedValue(null);

    const result = await saveSettingsAction(idleState, form({ logo: {} }));

    expect(result.status).toBe("error");
    expect(storageFrom).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
