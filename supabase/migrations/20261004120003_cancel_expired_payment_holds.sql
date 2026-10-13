-- ============================================================
-- Cobro al cliente (T6): limpieza de holds de pago vencidos.
--
-- Esto es LIMPIEZA, no regla de negocio: un hold vencido ya no ocupa cupo
-- (`create_booking`, `public_booking_load` y la agenda lo ignoran por su
-- `payment_expires_at`). Lo que hace el cron es pasar esas filas a
-- 'cancelled' para que no queden como "Pendiente" de por vida y para que el
-- historial diga la verdad.
--
-- `payment_status` se queda en 'awaiting' (igual que `cancel_payment_hold`):
-- el turno SÍ esperaba plata, y si el cliente paga tarde T5 necesita ver ese
-- estado para marcar el pago como "a devolver" (`refund_due`).
--
-- Es una única sentencia, así que es idempotente y atómica: la segunda
-- corrida no encuentra nada. Toma el lock de fila al actualizar, de modo que
-- un pago aprobado que llegue justo ahora (`apply_booking_payment`, que
-- también bloquea la fila) se serializa contra esto: o confirma antes de que
-- se cancele —y entonces ya no es 'pending'/'awaiting'— o encuentra el hold
-- cancelado y termina en `refund_due`.
-- ============================================================

create or replace function public.cancel_expired_payment_holds()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  v_count int;
begin
  update public.bookings
     set status = 'cancelled'
   where status = 'pending'
     and payment_status = 'awaiting'
     and payment_expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.cancel_expired_payment_holds() is
  'Cancela los holds de pago vencidos (pending + awaiting). Deja payment_status '
  'en awaiting para que un pago tardío se detecte. Devuelve la cantidad.';

-- Ver la nota larga en `20260808120001_public_booking_throttle.sql`: hay que
-- revocar de los tres roles, o la función queda abierta. La llama el cron con
-- el cliente admin; nadie más.
revoke execute on function public.cancel_expired_payment_holds()
  from public, anon, authenticated;
grant execute on function public.cancel_expired_payment_holds()
  to service_role;
