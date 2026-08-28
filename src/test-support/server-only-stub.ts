/**
 * Reemplazo de `server-only` para los tests.
 *
 * El paquete real tira apenas se lo importa fuera del bundler de Next, porque
 * asume que cualquier import que no pasó por él viene de un Client Component.
 * Un test de Node no lo es, así que el error es un falso positivo que hacía
 * imposible testear cualquier módulo con secretos — que son justamente los que
 * más conviene testear.
 *
 * Se aliasea sólo en `vitest.config.ts`. El build de Next sigue viendo el
 * paquete de verdad, así que el guard que rompe la compilación si alguien
 * importa un módulo de servidor desde el cliente sigue intacto.
 */
export {};
