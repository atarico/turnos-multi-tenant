-- ============================================================
-- Cobro al cliente (T7): cancelar un turno PAGADO sin perder la plata de vista.
--
-- Cancelar hoy es un UPDATE de `status` que la RLS le deja a cualquier miembro.
-- Sobre un turno pagado eso lo dejaría 'cancelled' + 'paid': el dinero entró y
-- nadie queda avisado de devolverlo. Tres piezas lo impiden:
--
--   1. CHECK `bookings_paid_not_cancelled`: un turno pagado no se cancela con
--      el UPDATE directo, ni por la UI ni por PostgREST con el JWT del dueño.
--   2. `cancel_paid_booking`: la ÚNICA puerta de cancelación de un pagado.
--      Cancela y marca 'refund_due' en el mismo UPDATE (el CHECK evalúa la fila
--      ya cambiada).
--   3. `mark_payment_refunded`: cierra el "a devolver" cuando el dueño ya
--      devolvió la plata desde su cuenta de Mercado Pago.
--
-- ## El CHECK contra los caminos que ya existen
--
-- Ninguno cancela un turno 'paid': `apply_booking_payment` cancela sólo desde
-- 'awaiting' y deja 'refund_due'; `cancel_expired_payment_holds` y las
-- cancelaciones de holds de `20261004120001` filtran 'awaiting'; una devolución
-- (refunded / charged_back) mueve `payment_status`, no `status`. Y 'paid' sólo
-- se alcanza por el UPDATE de confirmación de `apply_booking_payment`.
-- ============================================================

alter table public.bookings
  add constraint bookings_paid_not_cancelled
    check (not (status = 'cancelled' and payment_status = 'paid'));

-- ------------------------------------------------------------
-- Cancelar un turno pagado
--
-- SECURITY DEFINER con la autorización ADENTRO. El permiso es el de cancelar
-- hoy: cualquier MIEMBRO del negocio (la policy `bookings_update_members` no
-- distingue roles). Un turno de otro negocio y uno inexistente dan el mismo
-- 42501, sin revelar cuál es.
--
-- Errores distintos (P0001) para que la pantalla diga qué pasó:
--   · "ya está cerrado": el turno no está vivo (cancelado, completado, no vino);
--   · "no está pagado": está vivo pero no pagó (o ya está a devolver/devuelto).
-- ------------------------------------------------------------
create or replace function public.cancel_paid_booking(p_booking_id uuid)
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
     and tenant_id in (select public.auth_tenant_ids())
   for update;

  if not found then
    raise exception 'No tenés acceso a este turno'
      using errcode = 'insufficient_privilege';
  end if;

  if v_booking.status not in ('pending', 'confirmed') then
    raise exception 'Ese turno ya está cerrado'
      using errcode = 'P0001';
  end if;

  if v_booking.payment_status <> 'paid' then
    raise exception 'Ese turno no está pagado'
      using errcode = 'P0001';
  end if;

  update public.bookings
     set status         = 'cancelled',
         payment_status = 'refund_due'
   where id = v_booking.id
   returning * into v_booking;

  return v_booking;
end;
$$;

comment on function public.cancel_paid_booking(uuid) is
  'Cancela un turno pagado y lo deja a devolver (cancelled + refund_due) en un '
  'solo UPDATE. Cualquier miembro del negocio, igual que cancelar un turno sin '
  'pago. Única forma de cancelar un turno pagado.';

revoke execute on function public.cancel_paid_booking(uuid)
  from public, anon;
grant execute on function public.cancel_paid_booking(uuid) to authenticated;

-- ------------------------------------------------------------
-- Marcar una devolución como hecha
--
-- Sólo DUEÑO o ADMIN del negocio de ese pago: es plata, y un miembro `staff`
-- no tiene por qué cerrar devoluciones. Un extraño, un staff y un pago que no
-- existe reciben el mismo 42501 (el lookup ya filtra por rol): no se revela
-- si el id existe en otro negocio.
--
-- Dos ramas:
--   · fila 'refund_due' (plata EXTRA: cobro doble o no esperado): la fila pasa
--     a 'refunded' y el turno NO se toca — devolver el sobrante no le quita el
--     pago al turno;
--   · fila 'approved' de un turno 'refund_due' (el pago PRINCIPAL de un turno
--     cancelado): la fila Y el turno pasan a 'refunded'.
-- Cualquier otro estado da P0001 "no está pendiente de devolución".
--
-- Orden de locks: primero el TURNO y después la fila del pago, el mismo orden
-- que `apply_booking_payment`, para no armar un deadlock con un webhook.
-- ------------------------------------------------------------
create or replace function public.mark_payment_refunded(p_booking_payment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking_id uuid;
  v_payment    public.booking_payments;
  v_booking    public.bookings;
begin
  -- Lectura sin lock para saber qué turno bloquear primero.
  select p.booking_id into v_booking_id
    from public.booking_payments p
   where p.id = p_booking_payment_id
     and exists (
       select 1 from public.memberships m
        where m.tenant_id = p.tenant_id
          and m.user_id   = auth.uid()
          and m.role in ('owner', 'admin')
     );

  if not found then
    raise exception 'Sólo el dueño o un administrador pueden marcar una devolución'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_booking from public.bookings where id = v_booking_id for update;
  select * into v_payment
    from public.booking_payments
   where id = p_booking_payment_id
   for update;

  if v_payment.status = 'refund_due' then
    update public.booking_payments set status = 'refunded' where id = v_payment.id;
  elsif v_payment.status = 'approved' and v_booking.payment_status = 'refund_due' then
    update public.booking_payments set status = 'refunded' where id = v_payment.id;
    update public.bookings set payment_status = 'refunded' where id = v_booking.id;
  else
    raise exception 'Ese pago no está pendiente de devolución'
      using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.mark_payment_refunded(uuid) is
  'El dueño o un admin marca como devuelto un pago a devolver: la fila refund_due '
  '(plata extra) o la fila approved de un turno refund_due (que además pasa a '
  'refunded). Cualquier otro estado da P0001.';

revoke execute on function public.mark_payment_refunded(uuid)
  from public, anon;
grant execute on function public.mark_payment_refunded(uuid) to authenticated;
