-- ============================================================
-- Un turno sólo se cierra DESPUÉS de que ocurrió
--
-- El problema: un turno del 20 se marcó 'completed' hoy. Nada lo impedía
-- en ningún lado — ni el dominio (la tabla de transiciones es estado→estado
-- y no sabe nada del reloj), ni la Server Action, ni la base.
--
-- La regla: 'completed' y 'no_show' son afirmaciones sobre un HECHO
-- CONSUMADO (vino y se atendió / no vino), así que sólo son alcanzables
-- una vez pasado `ends_at`. 'confirmed' y 'cancelled' NO se tocan: son
-- decisiones sobre el futuro y cancelar un turno de la semana que viene
-- es el caso normal, no una excepción.
--
-- Por qué importa más que un botón mal puesto: un turno 'completed' entra
-- en `sum_monthly_revenue` (plata que nunca se cobró) y, por
-- `delete_service`/`delete_staff` (20260811120001), bloquea PARA SIEMPRE
-- el borrado de su servicio y su profesional — un servicio imborrable por
-- un turno que todavía no pasó.
--
-- Por qué en la base y no sólo en la app: el guard de la Server Action
-- protege el camino de la UI, pero el dueño autenticado tiene RLS de
-- UPDATE sobre sus propios turnos; un PATCH directo a PostgREST saltea la
-- Server Action entera. La invariante tiene que valer para CUALQUIER
-- camino de escritura, como ya valen `bookings_service_link_or_terminal`
-- y compañía.
-- ============================================================

-- ------------------------------------------------------------
-- Trigger y no CHECK, y no es una preferencia de estilo
--
-- Un `check (status not in ('completed','no_show') or ends_at <= now())`
-- ni siquiera se puede crear: Postgres exige que las funciones de un CHECK
-- sean IMMUTABLE y `now()` no lo es. Y con razón — un CHECK se re-evalúa
-- en cada revalidación de la tabla, así que un turno legítimamente cerrado
-- ayer pasaría a ser una fila "inválida" para siempre según cuándo se mire.
--
-- La invariante que importa es del MOMENTO DE LA ESCRITURA, y eso es
-- exactamente lo que un trigger `BEFORE` sabe expresar.
--
-- Se mira `new` y punto, sin comparar contra `old`: la condición es sobre
-- la fila RESULTANTE, no sobre el salto de estado. Así también queda
-- cubierto el caso de mover al futuro un turno ya cerrado (un UPDATE de
-- `ends_at` suelto), no sólo el de cerrar uno futuro.
--
-- `before insert or update of status, ends_at`: la lista de columnas hace
-- que el trigger ni se dispare en los UPDATEs que no tocan ninguna de las
-- dos — por ejemplo el `set service_id = null` de `delete_service()` sobre
-- turnos cancelled/no_show. El INSERT entra igual porque nada impide
-- insertar directo un turno futuro ya 'completed', y el `when` de abajo
-- descarta las filas vivas antes de entrar a la función.
--
-- `now()` (inicio de transacción) y no `clock_timestamp()`: es el mismo
-- reloj con el que `listBookingsToClose` decide qué turnos están vencidos,
-- así que la base y el panel coinciden en dónde está el borde.
--
-- OJO: esto NO limpia lo que ya está mal. Los turnos cerrados de más que
-- haya hoy en la tabla siguen ahí; el trigger sólo impide que se sumen
-- nuevos. Volverlos a 'confirmed' es una reparación aparte y manual.
-- ------------------------------------------------------------
create or replace function public.enforce_booking_closed_after_end()
returns trigger
language plpgsql
security invoker set search_path = public
as $$
begin
  if new.ends_at > now() then
    raise exception
      'El turno todavía no terminó (termina %): no se puede marcar como %',
      new.ends_at, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger bookings_close_only_after_end
  before insert or update of status, ends_at on public.bookings
  for each row
  when (new.status in ('completed', 'no_show'))
  execute function public.enforce_booking_closed_after_end();
