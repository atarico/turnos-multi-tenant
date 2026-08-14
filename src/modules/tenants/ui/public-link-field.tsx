"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { displayBookingUrl } from "@/modules/tenants/domain/public-url";

interface PublicLinkFieldProps {
  /** URL pública de reservas ya armada por quien renderiza. */
  url: string;
  className?: string;
}

/** Cuánto dura el "Copiado" antes de volver a ofrecer copiar. */
const COPIED_FEEDBACK_MS = 2000;

/**
 * El link público del negocio, listo para compartir: se ve entero, se abre en
 * otra pestaña y se copia de un click.
 *
 * Es uno solo para el panel, el catálogo y el modal de bienvenida: el link es
 * lo que el dueño manda a sus clientes, y tenía tres presentaciones distintas
 * (dos de ellas sin botón de copiar).
 */
export function PublicLinkField({ url, className }: PublicLinkFieldProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Portapapeles denegado o no soportado: se degrada sin romper — la URL
      // ya está a la vista, seleccionable, al lado del botón.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5",
        className,
      )}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate text-sm text-foreground transition-colors hover:text-gold"
      >
        {displayBookingUrl(url)}
      </a>
      <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? "Copiado" : "Copiar enlace"}
      </Button>
    </div>
  );
}
