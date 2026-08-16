"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

import {
  LOGO_BUCKET,
  logoExtensionFor,
  logoStoragePath,
  rejectLogo,
  type LogoRejection,
} from "../domain/logo";
import { getCurrentTenant } from "./queries";

/** El nombre del bucket vive en el dominio: lo usan la acción y `logoStoragePath`. */
const BUCKET = LOGO_BUCKET;

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

  /**
   * El logo que había ANTES, leído antes de pisarlo. Es lo único que después
   * permite borrar exactamente ese archivo y no el que subió otra pestaña.
   */
  const previousUrl = tenant.logo_url;

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

  /**
   * COMPARE-AND-SWAP: la escritura sólo pisa la fila si sigue apuntando al logo
   * que esta acción leyó.
   *
   * Sin la condición, dos subidas concurrentes escriben las dos y gana la
   * última. La que perdió nunca se entera: cree haber guardado, borra el logo
   * viejo que la otra ya borró, y deja SU archivo sin que ninguna fila lo
   * apunte ni ningún código lo vaya a borrar jamás. Ese huérfano es invisible y
   * permanente, y se suma uno por cada carrera.
   *
   * Con la condición, la perdedora ve cero filas afectadas, entra por el mismo
   * camino de error que ya existía, y limpia su propio archivo. El precio es
   * que un doble submit ahora muestra un error en vez de ganar en silencio —
   * ruidoso, pero honesto: el logo que quedó es el de la otra escritura, no el
   * de ésta.
   *
   * `is` y no `eq` cuando no había logo previo: en SQL nada es igual a `null`,
   * ni siquiera `null`. Un `.eq("logo_url", null)` no matchearía nunca y TODA
   * primera subida fallaría.
   */
  const write = supabase
    .from("tenants")
    .update({ logo_url: publicUrl })
    .eq("id", tenant.id);

  const { data, error } = await (previousUrl === null
    ? write.is("logo_url", null)
    : write.eq("logo_url", previousUrl)
  ).select("id");

  /**
   * `error: null` no prueba que se escribió: un UPDATE que RLS recorta a cero
   * filas vuelve como éxito con conjunto vacío. Acá duele más que en el color,
   * porque el archivo YA está en el bucket: decir "listo" dejaría un logo
   * subido que la fila no apunta.
   *
   * Cero filas ahora significa DOS cosas: que RLS lo frenó, o que otra subida
   * ganó la carrera y el compare-and-swap de arriba no matcheó. No hace falta
   * distinguirlas: en las dos, esta subida no quedó guardada y su archivo sobra.
   *
   * Y hay que DESHACER la subida, no sólo avisar del error. El archivo ya
   * existe: sin borrarlo queda un objeto que nadie apunta y que nadie va a
   * juntar nunca.
   *
   * Se borra el recién subido y NO el anterior: la fila apunta al viejo —o al
   * que puso la otra escritura—, así que llevárselo dejaría al negocio sin logo
   * por un error que no tuvo nada que ver con él.
   *
   * LÍMITE CONOCIDO, y no lo cierra este código: si este `remove` también
   * falla, el archivo queda huérfano igual. Son dos sistemas —Postgres y
   * Storage— sin una transacción que los abarque, así que siempre existe una
   * ventana. La única cura completa es un barredor: un job que borre objetos
   * que ninguna fila referencia. No está hecho. Se deja dicho en vez de
   * simular que la compensación alcanza.
   */
  if (error || !data || data.length === 0) {
    await supabase.storage.from(BUCKET).remove([path]);
    return errorState("No pudimos guardar el logo. Intentá de nuevo.");
  }

  await removePreviousLogo(supabase, previousUrl, tenant.id);

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

  await removePreviousLogo(supabase, tenant.logo_url, tenant.id);

  revalidatePath("/panel/configuracion");
  revalidatePath(`/${tenant.slug}`);

  return { status: "success", message: "Listo, sacamos tu logo." };
}

/**
 * Borra el logo ANTERIOR, identificado por su propia URL.
 *
 * La versión previa listaba la carpeta y borraba todo menos el archivo recién
 * subido. Eso se rompe con dos subidas simultáneas —doble click, dos pestañas,
 * dos personas—: la que termina última se lleva el archivo que la columna está
 * apuntando, y el negocio queda con una imagen rota en la página que ven sus
 * clientes. El review lo encontró; el barrido era el error de raíz.
 *
 * Borrando el anterior POR NOMBRE, dos subidas concurrentes intentan borrar el
 * mismo archivo viejo: una lo logra, la otra no encuentra nada, y ninguna toca
 * el archivo de la otra. Lo peor que puede pasar es que quede un huérfano
 * invisible, que es infinitamente mejor que un logo roto a la vista.
 *
 * Se hace DESPUÉS de que la fila apunta al archivo nuevo: si se borrara primero
 * y fallara el UPDATE, el negocio se quedaría sin logo Y con una columna
 * apuntando a un archivo inexistente.
 *
 * Su resultado no se mira a propósito. Para cuando corre, el logo nuevo ya está
 * guardado y andando: un borrado que falla deja basura, no un usuario roto.
 */
async function removePreviousLogo(
  supabase: Awaited<ReturnType<typeof createClient>>,
  previousUrl: string | null,
  tenantId: string,
): Promise<void> {
  const stale = logoStoragePath(previousUrl, tenantId);
  if (!stale) return;

  await supabase.storage.from(BUCKET).remove([stale]);
}
