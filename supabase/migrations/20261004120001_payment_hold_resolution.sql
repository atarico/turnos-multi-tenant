-- ============================================================
-- Cobro al cliente (T4): resolver un hold cuando el pago no arranca.
--
-- Cuando la reserva pública deja un hold ('pending' + 'awaiting') y después no
-- se puede crear el checkout en Mercado Pago, la app tiene que decidir qué
-- pasa con ESE turno. Son dos salidas, y ninguna puede hacerla una sesión:
--
--   * Falla de la CUENTA del negocio (token revocado, conexión rota): por la
--     decisión de producto, el negocio sigue tomando turnos sin pago. El hold
--     pasa a confirmado sin cobro: `release_payment_hold_without_payment`.
--   * Falla TRANSITORIA (Mercado Pago caído, red): no se regala el turno. El
--     hold se cancela y el cliente reintenta: `cancel_payment_hold`.
--
-- Ambas son SECURITY DEFINER con search_path fijo y sólo `service_role`: las
-- llama el servidor (acción pública con el cliente admin). A `authenticated`
-- no se las damos ni al dueño: confirmar un turno sin pagar es justo el
-- agujero que el CHECK `bookings_awaiting_not_confirmed` de T1 cierra, y esto
-- es la única puerta, con las condiciones adentro.
-- ============================================================

-- ------------------------------------------------------------
-- Hold -> confirmado sin pago
--
-- Sólo un hold VIGENTE: si ya venció, otro cliente pudo haber tomado la
-- franja (un hold vencido no ocupa cupo) y confirmarlo la duplicaría. El
-- error es distinto al de "no es un hold" para que quien llama sepa cuál fue.
--
-- Un único UPDATE mueve `status` y `payment_status` juntos: el CHECK
-- `bookings_awaiting_not_confirmed` evalúa la fila ya cambiada, así que nunca
-- existe un instante 'confirmed' + 'awaiting'. `payment_expires_at` vuelve a
-- null porque ya no hay nada que vencer.
-- ------------------------------------------------------------
create or replace function public.release_payment_hold_without_payment(
  p_booking_id uuid
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  -- `for update`: serializa contra un pago que llegue justo ahora (T5).
  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;
  if not found then
    raise exception 'Turno inexistente' using errcode = 'P0002';
  end if;

  if v_booking.status <> 'pending' or v_booking.payment_status <> 'awaiting' then
    raise exception 'Ese turno no espera un pago' using errcode = 'P0001';
  end if;

  if v_booking.payment_expires_at <= now() then
    raise exception 'El hold de pago ya venció' using errcode = 'P0001';
  end if;

  update public.bookings
     set status             = 'confirmed',
         payment_status     = 'not_required',
         payment_expires_at = null
   where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$$;

-- ------------------------------------------------------------
-- Hold -> cancelado
--
-- `payment_status` se queda en 'awaiting' (y el vencimiento, donde estaba) a
-- propósito: el turno SÍ esperaba plata. Si un pago llega tarde sobre un hold
-- ya cancelado, T5 necesita ver ese estado para marcarlo "a devolver"; con
-- 'not_required' parecería un pago sobre un turno que nunca lo pidió. Los
-- CHECK de T1 lo permiten: 'awaiting' sólo exige vencimiento y sólo prohíbe
-- 'confirmed'.
--
-- A diferencia del release, acá un hold vencido SÍ se cancela: liberar la fila
-- es lo que se quiere. Cancelado deja de ocupar cupo, igual que vencido.
-- ------------------------------------------------------------
create or replace function public.cancel_payment_hold(
  p_booking_id uuid
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  select * into v_booking
    from public.bookings
   where id = p_booking_id
   for update;
  if not found then
    raise exception 'Turno inexistente' using errcode = 'P0002';
  end if;

  if v_booking.status <> 'pending' or v_booking.payment_status <> 'awaiting' then
    raise exception 'Ese turno no espera un pago' using errcode = 'P0001';
  end if;

  update public.bookings
     set status = 'cancelled'
   where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$$;

-- Los privilegios por defecto de una función nueva incluyen PUBLIC: se
-- revocan a mano, y recién después se concede lo que se quiere.
revoke execute on function public.release_payment_hold_without_payment(uuid)
  from public, anon, authenticated;
grant execute on function public.release_payment_hold_without_payment(uuid)
  to service_role;

revoke execute on function public.cancel_payment_hold(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_payment_hold(uuid)
  to service_role;
