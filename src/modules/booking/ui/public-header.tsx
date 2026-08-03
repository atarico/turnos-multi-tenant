interface PublicHeaderProps {
  name: string;
  logoUrl: string | null;
  brandColor: string;
}

/**
 * Encabezado de la página pública de reservas: identidad del negocio (logo o
 * inicial del nombre) con el color de marca del tenant como acento. Es
 * presentacional puro — sin estado ni acciones, sólo pinta lo que la ruta le pasa.
 */
export function PublicHeader({ name, logoUrl, brandColor }: PublicHeaderProps) {
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
          className="flex size-14 shrink-0 items-center justify-center rounded-2xl font-display text-xl font-semibold text-on-gold"
          style={{ backgroundColor: brandColor }}
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}

      <div className="min-w-0">
        <p className="text-xs uppercase tracking-widest text-muted">
          Reservá tu turno
        </p>
        <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
          {name}
        </h1>
      </div>
    </header>
  );
}
