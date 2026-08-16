"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { type ActionState, idleState } from "@/core/action";

import { ALLOWED_LOGO_TYPES } from "../domain/logo";

interface LogoFormProps {
  /** Logo guardado hoy, o `null` si el negocio todavía no subió ninguno. */
  logoUrl: string | null;
  upload: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  remove: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

/**
 * Subida y borrado del logo del negocio.
 *
 * No hay cartel de "listo, lo subimos", y es deliberado: la confirmación de que
 * el logo se subió ES EL LOGO. La imagen de arriba cambia cuando la acción
 * revalida, y eso lo dice mejor que cualquier texto.
 *
 * De paso esquiva un defecto que ya nos mordió en otras pantallas: un cartel de
 * éxito que nadie limpia se queda pegado y termina afirmando algo que dejó de
 * ser cierto. El error sí se muestra, porque un error no tiene forma visible
 * propia — si el archivo se rechazó, en pantalla no cambia nada.
 */
export function LogoForm({ logoUrl, upload, remove }: LogoFormProps) {
  const [uploadState, uploadAction, uploading] = useActionState(
    upload,
    idleState,
  );
  const [removeState, removeAction, removing] = useActionState(
    remove,
    idleState,
  );

  const fieldError =
    uploadState.status === "error" ? uploadState.fieldErrors?.logo : undefined;

  /**
   * El banner general SÓLO aparece si no hay error de campo.
   *
   * Con un único campo, los dos dicen lo mismo: la acción usa el mismo texto
   * para el mensaje y para el error del campo, así que mostrar ambos repite la
   * frase palabra por palabra a diez píxeles de distancia. Cuando hay error de
   * campo gana el de campo, que está pegado al input que lo causó.
   *
   * El borrado no tiene campo propio, así que su error siempre va al banner.
   */
  const failure =
    uploadState.status === "error" && !fieldError
      ? uploadState.message
      : removeState.status === "error"
        ? removeState.message
        : undefined;

  return (
    <div className="space-y-4">
      {failure && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {failure}
        </p>
      )}

      {logoUrl && (
        // Logo del propio negocio, servido desde el bucket público. Va como
        // `<img>` y no `next/image` por la misma razón que en la página
        // pública: no se proxea por el optimizador una URL de subida libre.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt="Logo del negocio"
          className="size-20 rounded-2xl border border-border object-cover"
        />
      )}

      <form action={uploadAction} className="space-y-3">
        <div>
          <Label htmlFor="logo">Logo</Label>
          <input
            id="logo"
            name="logo"
            type="file"
            // El navegador no debería ni ofrecer lo que después vamos a
            // rechazar. Es comodidad, no seguridad: el filtro que cuenta está
            // en la acción y en el bucket.
            accept={ALLOWED_LOGO_TYPES.join(",")}
            className="mt-1 block w-full text-sm text-muted file:mr-3 file:rounded-xl file:border-0 file:bg-surface-3 file:px-4 file:py-2 file:text-sm file:text-foreground hover:file:bg-surface-2"
          />
          <p className="mt-1 text-xs text-faint">PNG, JPG o WEBP, hasta 2 MB.</p>
          {fieldError && <p className="mt-1 text-xs text-danger">{fieldError}</p>}
        </div>

        <Button type="submit" disabled={uploading}>
          {uploading ? "Subiendo…" : "Subir logo"}
        </Button>
      </form>

      {/*
        El borrado va en su PROPIO form: son dos acciones distintas con dos
        estados distintos, y meterlas en el mismo formulario obligaría a
        distinguir cuál se envió mirando qué botón se apretó.

        Y sólo existe si hay algo que sacar: ofrecerlo con la columna vacía es
        una acción que no puede hacer nada.
      */}
      {logoUrl && (
        <form action={removeAction}>
          <Button type="submit" variant="ghost" size="sm" disabled={removing}>
            {removing ? "Sacando…" : "Sacar logo"}
          </Button>
        </form>
      )}
    </div>
  );
}
