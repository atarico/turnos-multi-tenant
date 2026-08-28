import {
  DEFAULT_BRAND_COLOR,
  normalizeBrandColor,
  readableTextOn,
} from "@/modules/tenants/domain/brand";

interface PublicHeaderProps {
  name: string;
  logoUrl: string | null;
  brandColor: string;
}

/**
 * Encabezado de la página pública de reservas: identidad del negocio (logo o
 * inicial del nombre) con el color de marca del tenant como acento. Es
 * presentacional puro — sin estado ni acciones, sólo pinta lo que la ruta le pasa.
 *
 * El color de marca se usa como FONDO sólido, nunca como color de texto suelto:
 * como fondo, el texto encima se calcula con `readableTextOn` y el contraste
 * queda garantizado. Como color de texto, el contraste sería contra el fondo de
 * la página y un color oscuro desaparecería sobre el tema oscuro.
 *
 * Y aparece en DOS lugares, no en uno: el cuadradito de la inicial existe sólo
 * cuando no hay logo, así que un negocio con logo cargado no veía su color por
 * ningún lado. La etiqueta "Reservá tu turno" lo muestra siempre.
 */
export function PublicHeader({ name, logoUrl, brandColor }: PublicHeaderProps) {
  /**
   * El fondo se normaliza acá, no sólo el texto. `readableTextOn` ya cae a
   * blanco ante un color inválido, pero si el FONDO siguiera siendo ese valor
   * inválido el navegador lo descartaría y quedaría texto blanco sobre el fondo
   * de la página. Los dos tienen que caer juntos para que el par cierre.
   *
   * Hoy es defensivo —la columna es NOT NULL con default y la única escritura
   * pasa por `saveSettingsAction`— pero esta página la ven los clientes del
   * negocio y no cuesta nada sostener la invariante en el borde.
   */
  const background = normalizeBrandColor(brandColor) ?? DEFAULT_BRAND_COLOR;
  const onBrand = readableTextOn(background);

  return (
    <header className="flex items-center gap-4">
      {logoUrl ? (
        // Logo cargado por el negocio: URL arbitraria y ajena. La servimos tal
        // cual, sin pasarla por el optimizador de Next (evita proxiar destinos
        // que no controlamos). Por eso `<img>` y no `next/image`.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt={name}
          className="size-14 shrink-0 rounded-2xl border border-border object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center rounded-2xl font-display text-xl font-semibold"
          style={{ backgroundColor: background, color: onBrand }}
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}

      <div className="min-w-0">
        <p
          className="inline-block rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-widest"
          style={{ backgroundColor: background, color: onBrand }}
        >
          Reservá tu turno
        </p>
        <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
          {name}
        </h1>
      </div>
    </header>
  );
}
