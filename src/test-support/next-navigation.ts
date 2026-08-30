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

/**
 * Lo mismo que {@link throwingRedirectSpy} pero para `notFound()`.
 *
 * Vive aparte porque en un guard las dos salidas NO son intercambiables: una
 * manda al login y la otra dice que la ruta no existe. Un test que sólo mira
 * "cortó la ejecución" pasaría igual si alguien cambiara el 404 por un
 * redirect, que es justo el cambio que hay que impedir. Sentinelas distintos
 * para poder afirmar CUÁL de las dos puertas se cerró.
 */
export function throwingNotFoundSpy() {
  return vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  });
}
