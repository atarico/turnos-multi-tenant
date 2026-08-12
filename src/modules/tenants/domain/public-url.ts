/**
 * Public booking URL helpers. Pure — no `process.env` / `serverEnv()` reads
 * in here so this stays testable in the `domain` (node) vitest project and
 * usable from both Server and Client Components without re-opening the
 * `NEXT_PUBLIC_*` inlining trap (callers inject the origin).
 */

/** Builds the tenant's public booking URL from an origin and its slug. */
export function publicBookingUrl(origin: string, slug: string): string {
  const trimmedOrigin = origin.replace(/\/+$/, "");
  const trimmedSlug = slug.replace(/^\/+/, "");
  return `${trimmedOrigin}/${trimmedSlug}`;
}

/** "https://turnos.app/acme" → "turnos.app/acme" (display label only). */
export function displayBookingUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
