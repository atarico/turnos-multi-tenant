import { vi } from "vitest";

/**
 * Espía de `redirect()` que corta la ejecución lanzando, igual que el real.
 *
 * Si el mock devolviera `undefined` la page seguiría renderizando después del
 * redirect —con el tenant en null, por ejemplo— y el test terminaría probando
 * una pantalla que en producción nadie ve.
 *
 * Se usa junto al mock del módulo, que no puede vivir acá: `vi.mock` sólo se
 * iza dentro del archivo de test que lo declara.
 *
 *     const redirect = throwingRedirectSpy();
 *     vi.mock("next/navigation", () => ({
 *       redirect: (path: string) => redirect(path),
 *     }));
 */
export function throwingRedirectSpy() {
  return vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  });
}
