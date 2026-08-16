"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

import { logoExtensionFor, rejectLogo, type LogoRejection } from "../domain/logo";
import { getCurrentTenant } from "./queries";

/** Bucket declarado en `20260816120001_tenant_logos_bucket.sql`. */
const BUCKET = "tenant-logos";

/**
 * Con 12 bytes alcanzan las tres firmas que reconocemos — la más larga es WEBP,
 * que necesita llegar al offset 8. No hace falta leer el archivo entero para
 * saber qué es.
 */
const HEAD_BYTES = 12;

const MESSAGES: Record<LogoRejection, string> = {
  empty: "El archivo está vacío.",
  size: "El logo no puede pesar más de 2 MB.",
  type: "Sólo aceptamos PNG, JPG o WEBP.",
  content: "El archivo no parece ser la imagen que dice ser.",
};

/**
 * Sube el logo del negocio y lo deja apuntado en `tenants.logo_url`.
 *
 * El orden no es casual: se valida ANTES de tocar Storage. Un archivo
 * peligroso que llega al bucket ya quedó servido en una URL pública aunque
 * después falle el resto del flujo — rechazar tarde no es rechazar.
 */
export async function uploadLogoAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) {
    return errorState("Elegí un archivo.", { logo: "Elegí un archivo." });
  }

  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const rejection = rejectLogo({ type: file.type, size: file.size, head });
  if (rejection) {
    return errorState(MESSAGES[rejection], { logo: MESSAGES[rejection] });
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio.");

  const extension = logoExtensionFor(file.type);
  /**
   * Nombre único por subida, y el id del negocio ADELANTE.
   *
   * El primer segmento es lo único que la política de Storage puede mirar para
   * decidir de quién es el archivo, así que la ruta es la autorización.
   *
   * El nombre aleatorio evita el otro problema: reusar el mismo nombre deja la
   * URL igual, y un CDN puede seguir sirviendo el logo anterior. Con nombre
   * nuevo, la URL nueva no tiene caché que la contradiga.
   */
  const fileName = `${crypto.randomUUID()}.${extension}`;
  const path = `${tenant.id}/${fileName}`;

  const supabase = await createClient();
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type });

  if (uploadError) {
    return errorState("No pudimos subir el logo. Intentá de nuevo.");
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET).getPublicUrl(path);

  const { data, error } = await supabase
    .from("tenants")
    .update({ logo_url: publicUrl })
    .eq("id", tenant.id)
    .select("id");

  /**
   * `error: null` no prueba que se escribió: un UPDATE que RLS recorta a cero
   * filas vuelve como éxito con conjunto vacío. Acá duele más que en el color,
   * porque el archivo YA está en el bucket: decir "listo" dejaría un logo
   * subido que la fila no apunta.
   */
  if (error || !data || data.length === 0) {
    return errorState("No pudimos guardar el logo. Intentá de nuevo.");
  }

  await removeOtherLogos(supabase, tenant.id, fileName);

  revalidatePath("/panel/configuracion");
  revalidatePath(`/${tenant.slug}`);

  return { status: "success", message: "Listo, subimos tu logo." };
}

/**
 * Saca el logo del negocio: vacía la columna y borra los archivos.
 *
 * No declara `prev` ni `formData` porque no los usa: el negocio sale de la
 * sesión y no hay nada que leer del formulario. `useActionState` los pasa
 * igual y JavaScript los descarta; declarar parámetros que se ignoran sólo
 * haría creer que la acción depende de algo que no mira.
 */
export async function removeLogoAction(): Promise<ActionState> {
  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio.");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .update({ logo_url: null })
    .eq("id", tenant.id)
    .select("id");

  if (error || !data || data.length === 0) {
    return errorState("No pudimos sacar el logo. Intentá de nuevo.");
  }

  await removeOtherLogos(supabase, tenant.id, null);

  revalidatePath("/panel/configuracion");
  revalidatePath(`/${tenant.slug}`);

  return { status: "success", message: "Listo, sacamos tu logo." };
}

/**
 * Borra todo lo que haya en la carpeta del negocio salvo `keep`.
 *
 * Se hace DESPUÉS de que la fila quedó apuntando al archivo nuevo, y no antes:
 * si se borrara primero y después fallara el UPDATE, el negocio se quedaría sin
 * logo y con una columna apuntando a un archivo que ya no existe.
 *
 * Barre la carpeta entera en vez de borrar sólo el anterior porque también
 * limpia los huérfanos que haya dejado un intento fallido. Y su resultado no se
 * mira: el logo nuevo ya está guardado y andando, así que un borrado que falla
 * deja basura, no un usuario roto. Fallar acá sería peor que no fallar.
 */
async function removeOtherLogos(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  keep: string | null,
): Promise<void> {
  const { data: existing } = await supabase.storage.from(BUCKET).list(tenantId);
  if (!existing) return;

  const stale = existing
    .filter((entry) => entry.name !== keep)
    .map((entry) => `${tenantId}/${entry.name}`);

  if (stale.length > 0) {
    await supabase.storage.from(BUCKET).remove(stale);
  }
}
