"use server";

import { revalidatePath } from "next/cache";

import { type ActionState, errorState } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

import { normalizeBrandColor } from "../domain/brand";
import {
  LOGO_BUCKET,
  logoExtensionFor,
  logoStoragePath,
  rejectLogo,
  type LogoRejection,
} from "../domain/logo";
import { getCurrentTenant } from "./queries";

const BUCKET = LOGO_BUCKET;

/** Con 12 bytes alcanzan las tres firmas: la más larga es WEBP, en offset 8. */
const HEAD_BYTES = 12;

const LOGO_MESSAGES: Record<LogoRejection, string> = {
  empty: "El archivo está vacío.",
  size: "El logo no puede pesar más de 2 MB.",
  type: "Sólo aceptamos PNG, JPG o WEBP.",
  content: "El archivo no parece ser la imagen que dice ser.",
};

/**
 * Qué hacer con el logo en este submit.
 *
 * `undefined` significa NO TOCARLO, y es distinto de `null`, que significa
 * sacarlo. Sin esa distinción, cualquier guardado de color borraría el logo.
 */
type LogoIntent = { url: string; path: string } | null | undefined;

/**
 * Guarda la configuración del negocio: color de marca y logo, juntos.
 *
 * Un solo botón en pantalla, una sola acción acá, y —lo que de verdad importa—
 * UNA SOLA escritura a la fila. Cuando eran dos acciones separadas podían
 * quedar a medias: el color guardado, el logo no, sin que nada lo dijera.
 *
 * El orden es deliberado: primero se valida TODO, después se sube, y recién al
 * final se escribe. Así un archivo inválido no deja el color a medio guardar, y
 * un color inválido no deja un archivo subido al pedo.
 */
export async function saveSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // ---- 1. Validar todo antes de tocar nada ------------------------------
  const brandColor = normalizeBrandColor(String(formData.get("brandColor") ?? ""));
  if (!brandColor) {
    return errorState("Revisá los datos del formulario.", {
      brandColor: "Elegí un color válido.",
    });
  }

  const file = formData.get("logo");
  const newLogo = file instanceof File && file.size > 0 ? file : null;
  /**
   * Un archivo elegido GANA sobre el pedido de sacar el logo. La casilla sólo
   * se muestra cuando no hay archivo, así que si llegan los dos es porque el
   * usuario eligió el archivo después de tildarla: su última intención manda.
   */
  const removeRequested = !newLogo && formData.get("removeLogo") === "on";

  if (newLogo) {
    const head = new Uint8Array(await newLogo.slice(0, HEAD_BYTES).arrayBuffer());
    const rejection = rejectLogo({
      type: newLogo.type,
      size: newLogo.size,
      head,
    });
    if (rejection) {
      return errorState(LOGO_MESSAGES[rejection], {
        logo: LOGO_MESSAGES[rejection],
      });
    }
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return errorState("No encontramos tu negocio.");

  /** El logo que había antes: lo único que permite borrar EXACTAMENTE ése. */
  const previousUrl = tenant.logo_url;
  const supabase = await createClient();

  // ---- 2. Subir, si hay algo que subir ----------------------------------
  let logo: LogoIntent = undefined;

  if (newLogo) {
    // Nombre único: reusar el mismo dejaría la URL igual y un CDN podría
    // seguir sirviendo el logo anterior. El id del negocio va ADELANTE porque
    // la política de Storage sólo puede mirar el primer segmento de la ruta.
    const path = `${tenant.id}/${crypto.randomUUID()}.${logoExtensionFor(newLogo.type)}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, newLogo, { contentType: newLogo.type });

    if (uploadError) {
      return errorState("No pudimos subir el logo. Intentá de nuevo.");
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(BUCKET).getPublicUrl(path);
    logo = { url: publicUrl, path };
  } else if (removeRequested) {
    logo = null;
  }

  // ---- 3. Una sola escritura -------------------------------------------
  const values: Record<string, unknown> = { brand_color: brandColor };
  if (logo !== undefined) values.logo_url = logo === null ? null : logo.url;

  let write = supabase.from("tenants").update(values).eq("id", tenant.id);

  /**
   * COMPARE-AND-SWAP, y SÓLO cuando el logo cambia.
   *
   * Si el logo cambia, hay un archivo que puede quedar huérfano: dos guardados
   * concurrentes escribirían los dos, ganaría el último, y el archivo del que
   * perdió quedaría sin fila que lo apunte ni código que lo borre. La condición
   * hace que el perdedor se entere y limpie lo suyo.
   *
   * Si sólo cambia el color no hay archivo en juego, así que condicionar sería
   * hacer fallar el guardado por una carrera sin consecuencia.
   *
   * `is` y no `eq` contra null: en SQL nada es igual a `null`, ni siquiera
   * `null`. Un `.eq("logo_url", null)` no matchearía nunca y TODA primera
   * subida fallaría, borrando además el archivo recién subido.
   */
  if (logo !== undefined) {
    write =
      previousUrl === null
        ? write.is("logo_url", null)
        : write.eq("logo_url", previousUrl);
  }

  const { data, error } = await write.select("id");

  /**
   * Cero filas significa dos cosas —RLS lo frenó, o el compare-and-swap no
   * matcheó porque otro guardado ganó— y en las dos este guardado no quedó.
   *
   * `error: null` no prueba que se escribió: un UPDATE recortado a cero filas
   * vuelve como éxito con conjunto vacío.
   *
   * LÍMITE CONOCIDO: si este `remove` compensatorio también falla, el archivo
   * queda huérfano igual. Son dos sistemas sin una transacción que los abarque.
   * La cura completa es un barredor de objetos sin referencia, que no existe.
   */
  if (error || !data || data.length === 0) {
    if (logo) await supabase.storage.from(BUCKET).remove([logo.path]);
    return errorState("No pudimos guardar los cambios. Intentá de nuevo.");
  }

  // ---- 4. Recién ahora, limpiar el logo viejo ---------------------------
  // Después de que la fila apunta al nuevo: si se borrara antes y la escritura
  // fallara, el negocio quedaría sin logo y con una columna apuntando al vacío.
  if (logo !== undefined) {
    const stale = logoStoragePath(previousUrl, tenant.id);
    if (stale) await supabase.storage.from(BUCKET).remove([stale]);
  }

  revalidatePath("/panel/configuracion");
  // La página pública es donde el color y el logo se ven de verdad.
  revalidatePath(`/${tenant.slug}`);

  return { status: "success", message: "Listo, guardamos los cambios." };
}
