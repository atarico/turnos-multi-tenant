"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { displayBookingUrl } from "@/modules/tenants/domain/public-url";

/** localStorage key gating the modal — value `"true"` means "don't show again". */
export const PUBLIC_LINK_DIALOG_DISMISSED_KEY =
  "turnos:public-link-modal:dismissed";

interface PublicLinkDialogProps {
  /** Public booking URL already built by the Server Component. */
  url: string;
  /** `searchParams.bienvenida === "1"` — this browser just finished signup/login. */
  triggered: boolean;
}

/** Storage access can throw (Safari private mode, disabled storage). A failed
 * read must degrade to "show the modal", never crash the panel. */
function readDismissed(): boolean {
  try {
    return localStorage.getItem(PUBLIC_LINK_DIALOG_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    localStorage.setItem(PUBLIC_LINK_DIALOG_DISMISSED_KEY, "true");
  } catch {
    // Storage disabled: nothing to persist, the modal will just show again.
  }
}

// No other tab/writer needs to push updates into this component, so the
// store never notifies — `subscribe` just satisfies the contract.
function subscribeToStorage(): () => void {
  return () => {};
}

/** Server never has localStorage: treat "unknown" as "not dismissed" so the
 * server snapshot and the very first client snapshot agree — no hydration
 * mismatch, and no effect needed to defer the read past mount. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * Post-login/signup modal nudging the owner toward their public booking
 * link. Gated by a query-param trigger (not pure localStorage) so
 * client-side back-navigation into `/panel` doesn't reopen it every time —
 * see design decision "Trigger = query param on the auth redirects".
 *
 * Plain ARIA `role="dialog"` instead of native `<dialog>`: jsdom 29 has no
 * `showModal()` implementation, so a native dialog would be untestable here.
 * No full focus trap (deferred, documented tradeoff) — Escape, backdrop
 * click and initial focus only.
 */
export function PublicLinkDialog({ url, triggered }: PublicLinkDialogProps) {
  const [copied, setCopied] = useState(false);
  const [rememberChoice, setRememberChoice] = useState(false);
  const [closedByUser, setClosedByUser] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const dismissedInStorage = useSyncExternalStore(
    subscribeToStorage,
    readDismissed,
    getServerSnapshot,
  );
  const open = triggered && !dismissedInStorage && !closedByUser;

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  function close() {
    if (rememberChoice) {
      persistDismissed();
    }
    setClosedByUser(true);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard denied/unsupported: degrade, never crash — the URL is
      // already rendered as selectable text right beside this button.
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-link-dialog-title"
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.85)] outline-none"
      >
        <h2
          id="public-link-dialog-title"
          className="font-display text-xl font-semibold tracking-tight"
        >
          ¡Ya podés compartir tu link!
        </h2>
        <p className="mt-2 text-sm text-muted">
          Mandaselo a tus clientes para que reserven solos.
        </p>

        <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {displayBookingUrl(url)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copiado" : "Copiar enlace"}
          </Button>
        </div>

        <label className="mt-5 inline-flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={rememberChoice}
            onChange={(e) => setRememberChoice(e.target.checked)}
            className="size-4 accent-gold"
          />
          No volver a mostrar
        </label>

        <div className="mt-6 flex justify-end">
          <Button type="button" onClick={close}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
