"use client";

import { useActionState, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { type ActionState, idleState } from "@/core/action";

import { readableTextOn } from "../domain/brand";
import { ALLOWED_LOGO_TYPES } from "../domain/logo";

interface SettingsFormProps {
  /** Color guardado hoy, tal como viene de la base. */
  brandColor: string;
  /** Logo guardado hoy, o `null` si el negocio todavía no subió ninguno. */
  logoUrl: string | null;
  /** La Server Action llega inyectada: así el form se testea con un espía. */
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

/**
 * Configuración visible del negocio: color de marca y logo, en UN formulario
 * con UN botón.
 *
 * Que estén juntos no es sólo comodidad de pantalla: la acción los guarda en
 * una sola escritura, así que o entran los dos o no entra ninguno. Cuando eran
 * dos formularios podían quedar a medias sin que nada lo dijera.
 */
export function SettingsForm({ brandColor, logoUrl, save }: SettingsFormProps) {
  const [state, action, pending] = useActionState(save, idleState);

  // El input de color va CONTROLADO: React 19 hace `requestFormReset` al
  // resolver la action y uno no controlado volvería a su `defaultValue`,
  // mostrando el color anterior justo después de guardar el nuevo.
  const [color, setColor] = useState(brandColor);

  /**
   * Vista previa del archivo recién elegido, como `blob:` local.
   *
   * Se genera en el navegador y no espera al servidor: la gracia es ver QUÉ
   * archivo elegiste antes de guardarlo. Guarda también la URL anterior para
   * revocarla — cada `createObjectURL` reserva memoria hasta que se libera.
   */
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const replacePreview = (next: string | null) => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return next;
    });
  };

  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    replacePreview(file ? URL.createObjectURL(file) : null);
  };

  const undoPick = () => {
    if (fileRef.current) fileRef.current.value = "";
    replacePreview(null);
  };

  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;
  /**
   * El cartel de éxito se DERIVA: vale mientras lo que hay en pantalla siga
   * siendo lo que el servidor devolvió. `brandColor` llega fresco del server
   * component tras el `revalidatePath`, así que si el usuario vuelve a tocar el
   * color deja de coincidir y el cartel se baja solo, en vez de quedar pegado
   * afirmando algo que ya no es cierto.
   */
  const showSuccess = state.status === "success" && color === brandColor;
  const onBrand = readableTextOn(color);

  /** Lo que se muestra arriba: lo recién elegido gana sobre lo guardado. */
  const shownLogo = preview ?? logoUrl;

  return (
    <form action={action} className="space-y-8">
      {state.status === "error" && !fieldErrors && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}

      {showSuccess && state.message && (
        <p className="rounded-xl border border-success/30 bg-success/10 px-3.5 py-2.5 text-sm text-success">
          {state.message}
        </p>
      )}

      <section className="space-y-3">
        <div>
          <Label htmlFor="brandColor">Color de marca</Label>
          <div className="mt-1 flex items-center gap-3">
            <input
              id="brandColor"
              name="brandColor"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-11 w-16 shrink-0 cursor-pointer rounded-xl border border-border bg-surface-2 p-1"
            />
            <code className="text-sm uppercase tracking-wide text-muted">
              {color}
            </code>
          </div>
          {fieldErrors?.brandColor && (
            <p className="mt-1 text-xs text-danger">{fieldErrors.brandColor}</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <Label htmlFor="logo">Logo</Label>
          <input
            id="logo"
            name="logo"
            type="file"
            ref={fileRef}
            onChange={onPickFile}
            // Comodidad, no seguridad: el filtro que cuenta está en la acción
            // (que además mira los bytes) y en el bucket.
            accept={ALLOWED_LOGO_TYPES.join(",")}
            className="mt-1 block w-full text-sm text-muted file:mr-3 file:rounded-xl file:border-0 file:bg-surface-3 file:px-4 file:py-2 file:text-sm file:text-foreground hover:file:bg-surface-2"
          />
          <p className="mt-1 text-xs text-faint">PNG, JPG o WEBP, hasta 2 MB.</p>
          {fieldErrors?.logo && (
            <p className="mt-1 text-xs text-danger">{fieldErrors.logo}</p>
          )}
        </div>

        {preview && (
          <button
            type="button"
            onClick={undoPick}
            className="text-xs text-muted underline underline-offset-4 transition-colors hover:text-foreground"
          >
            Deshacer la elección
          </button>
        )}

        {/*
          Sacar el logo sólo tiene sentido si hay uno Y no se eligió archivo
          nuevo: con un archivo elegido, ése es el pedido del usuario y la
          casilla diría lo contrario.
        */}
        {logoUrl && !preview && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              name="removeLogo"
              className="size-4 rounded border-border bg-surface-2"
            />
            Sacar el logo al guardar
          </label>
        )}
      </section>

      <section>
        <p className="text-xs uppercase tracking-widest text-muted">
          Así se ve en tu página
        </p>
        {/*
          Usa el color y el archivo del estado local, no lo guardado: la gracia
          es ver el cambio ANTES de apretar guardar. El texto se calcula con la
          misma función que la página pública, así que la vista previa no puede
          mentir sobre el contraste real.
        */}
        <div className="mt-2 flex items-center gap-4 rounded-2xl border border-border bg-surface-2 p-4">
          {shownLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shownLogo}
              alt="Logo del negocio"
              className="size-14 shrink-0 rounded-2xl border border-border object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-14 shrink-0 items-center justify-center rounded-2xl font-display text-xl font-semibold"
              style={{ backgroundColor: color, color: onBrand }}
            >
              A
            </span>
          )}
          <div className="min-w-0">
            <p
              className="inline-block rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-widest"
              style={{ backgroundColor: color, color: onBrand }}
            >
              Reservá tu turno
            </p>
            <p className="truncate font-display text-lg font-semibold tracking-tight">
              Tu negocio
            </p>
          </div>
        </div>
      </section>

      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar cambios"}
      </Button>
    </form>
  );
}
