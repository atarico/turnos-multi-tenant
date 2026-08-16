/**
 * Resultado de una escritura de PostgREST a la que se le pidió `.select()`.
 *
 * `data` es la lista de filas AFECTADAS. Sin `.select()` llega en `null`,
 * porque PostgREST responde 204 sin cuerpo y no hay nada que contar.
 */
interface WriteResult {
  data: unknown[] | null | undefined;
  error: unknown;
}

/**
 * ¿La escritura tocó alguna fila de verdad?
 *
 * Existe por un comportamiento de PostgREST que es fácil de no ver: cuando RLS
 * recorta un UPDATE o un DELETE a cero filas, **no devuelve error**. Devuelve
 * éxito con un conjunto vacío. El código que sólo pregunta "¿hubo error?"
 * concluye que guardó, responde "listo", y no guardó nada.
 *
 * También cubre el caso menos exótico y más frecuente: un `id` que ya no
 * existe. Dos pestañas abiertas, borrás un servicio en una y lo editás en la
 * otra — sin este chequeo la segunda dice "Servicio actualizado."
 *
 * SÓLO hace falta en UPDATE y DELETE. Un INSERT bloqueado por RLS sí devuelve
 * error (`new row violates row-level security policy`), así que ahí el chequeo
 * clásico alcanza.
 *
 * Y NO va en toda escritura: donde cero filas es un resultado legítimo —el
 * DELETE que reconcilia `staff_services`, por ejemplo, que borra "lo que
 * sobra" y a veces no sobra nada— poner este guard rompería el caso normal.
 * Es para escrituras dirigidas a una fila que TIENE que estar.
 *
 * Requiere que la consulta pida `.select(...)`. Sin eso `data` viene `null` y
 * esto responde `false`: preferimos negar un guardado que sí ocurrió antes que
 * afirmar uno que nadie confirmó.
 */
export function wroteRows({ data, error }: WriteResult): boolean {
  return !error && Array.isArray(data) && data.length > 0;
}
