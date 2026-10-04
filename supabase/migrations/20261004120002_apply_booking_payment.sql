-- ============================================================
-- Cobro al cliente (T5): aplicar un pago de Mercado Pago sobre el turno.
--
-- La llama el servidor DESPUÉS de volver a leer el pago en Mercado Pago con el
-- token del negocio (webhook o retorno del checkout). Esta función no
-- autentica nada: asume que `p_status`, el monto y la moneda salen de ESA
-- lectura y no del aviso. Por eso el EXECUTE queda sólo en `service_role`
-- (mismo criterio que `apply_subscription_payment`): quien pudiera ejecutarla
-- se confirmaba turnos sin pagar inventando un id de pago.
--
-- ## Idempotencia
--
-- Mercado Pago reintenta y, además, el retorno del checkout dispara la misma
-- aplicación que el webhook. El freno es `payment_events`, con la clave
-- `<payment_id>:<status>`: un mismo pago que cambia de estado se aplica una
-- vez por estado, y el reintento choca y devuelve `duplicate`.
--
-- Todo corre en UNA transacción: si algo falla después del reclamo, el reclamo
-- se va con el rollback y el reintento tiene su chance.
--
-- ## Qué decide
--
--   approved a tiempo + monto y moneda del turno     -> confirmed / paid
--   approved sobre un hold cancelado, aprobado DESPUÉS
--   del vencimiento, o con otro monto o moneda       -> refund_due y el turno
--                                                       queda CANCELADO: la
--                                                       plata entró pero el
--                                                       turno no se da
--   approved sobre un turno que ya no espera pago    -> el turno no cambia y
--   (cobro doble, o un turno que nunca lo pidió)          ese pago queda
--                                                       'refund_due' en
--                                                       booking_payments
--   rejected / cancelled                             -> sólo booking_payments;
--                                                       el hold sigue para que
--                                                       el cliente reintente
--   refunded / charged_back sobre un turno pagado o
--   a devolver                                       -> refunded
--
-- "A tiempo" = `p_approved_at <= payment_expires_at` y el turno no está
-- cancelado. Mira CUÁNDO se acreditó y no cuándo se procesa: un pago hecho
-- dentro de la ventana no se pierde porque el webhook llegó tarde. Si ya pasó
-- el vencimiento, la franja pudo tomarla otro cliente (un hold vencido no
-- ocupa cupo), así que antes de confirmar se re-chequea el cupo con el mismo
-- lock y el mismo predicado que `create_booking` (`booking_slot_has_room`).
--
-- Devuelve 'applied' | 'duplicate' | 'ignored'. 'ignored' es un éxito: no hay
-- nada que aplicar (turno de otro negocio o inexistente, un turno que no
-- esperaba pago, un estado que no mueve nada).
-- ============================================================

-- ------------------------------------------------------------
-- ¿Queda lugar para este turno en su franja?
--
-- Espeja la cuenta de `create_booking` (`20261003120001`): mismo lock por
-- profesional, mismas reservas vivas que se solapan, mismo predicado de hold
-- vencido, y las dos condiciones de rechazo (otra sesión solapada / cupo
-- lleno). La diferencia es que el turno que se evalúa YA existe, así que se
-- excluye a sí mismo de la cuenta. Si `create_booking` cambia su regla, cambia
-- acá también.
--
-- Toma `pg_advisory_xact_lock`: serializa contra una reserva que entre justo
-- ahora y se libera sola al cerrar la transacción. Sólo `service_role`; la
-- llama `apply_booking_payment`.
-- ------------------------------------------------------------
create or replace function public.booking_slot_has_room(p_booking_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking public.bookings;
  v_service public.services;
  v_taken   int;
  v_others  int;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if not found or v_booking.staff_id is null then
    return false;
  end if;

  select * into v_service from public.services where id = v_booking.service_id;
  if not found then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_booking.staff_id::text, 0));

  select
    count(*) filter (where service_id = v_booking.service_id and starts_at = v_booking.starts_at),
    count(*) filter (where not (service_id = v_booking.service_id and starts_at = v_booking.starts_at))
  into v_taken, v_others
  from public.bookings
  where staff_id = v_booking.staff_id
    and id <> v_booking.id
    and status in ('pending', 'confirmed')
    and not (status = 'pending' and payment_status = 'awaiting'
             and payment_expires_at <= now())
    and starts_at < v_booking.ends_at
    and ends_at   > v_booking.starts_at;

  return v_others = 0 and v_taken < v_service.capacity;
end;
$$;

revoke execute on function public.booking_slot_has_room(uuid)
  from public, anon, authenticated;
grant execute on function public.booking_slot_has_room(uuid) to service_role;

create or replace function public.apply_booking_payment(
  p_tenant_id      uuid,
  p_booking_id     uuid,
  p_mp_payment_id  text,
  p_status         text,
  p_amount_cents   int,
  p_currency       text,
  p_approved_at    timestamptz default null
)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking public.bookings;
  v_claimed int;
  v_confirm boolean;
  v_found   int;
  v_result  text := 'ignored';
  -- Cuándo se acreditó. Sin dato se toma "ahora": el comportamiento de antes.
  v_approved   timestamptz := coalesce(p_approved_at, now());
  -- Qué estado se anota en booking_payments (suele ser el de Mercado Pago).
  v_row_status text := p_status;
  -- Cómo estaba anotado ESTE pago antes del aviso (null si no lo conocemos).
  v_prev_row_status text;
begin
  -- El turno tiene que ser de ESE negocio. Sin esto, un pago legítimo de un
  -- negocio podría apuntarse a un turno de otro con sólo cambiar la
  -- referencia. `for update` serializa contra el retorno del checkout, contra
  -- un cancel del hold y contra otro aviso del mismo pago.
  --
  -- No se reclama el evento antes de esta lectura: un aviso que no
  -- corresponde a nada no tiene por qué quedar marcado como procesado.
  select * into v_booking
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    return 'ignored';
  end if;

  insert into public.payment_events (provider, provider_event_id, tenant_id)
  values ('mercadopago', p_mp_payment_id || ':' || p_status, p_tenant_id)
  on conflict (provider, provider_event_id) do nothing;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'duplicate';
  end if;

  -- ----- Qué hace el estado con el turno -----
  if p_status = 'approved' then
    if v_booking.payment_status = 'awaiting' then
      -- Se confirma sólo si el turno sigue pendiente, el pago se acreditó
      -- dentro de la ventana del hold y el monto y la moneda son los del turno.
      v_confirm := v_booking.status = 'pending'
                   and v_approved <= v_booking.payment_expires_at
                   and p_amount_cents = v_booking.price_cents
                   and upper(p_currency) = upper(v_booking.currency);

      -- Pagó a tiempo pero se procesa con el hold ya vencido: un hold vencido
      -- no ocupa cupo, así que otro cliente pudo tomar la franja. Confirmar
      -- sin mirar la duplicaría.
      if v_confirm and now() > v_booking.payment_expires_at then
        v_confirm := public.booking_slot_has_room(v_booking.id);
      end if;

      if v_confirm then
        -- Un único UPDATE mueve `status` y `payment_status`: el CHECK
        -- `bookings_awaiting_not_confirmed` evalúa la fila ya cambiada.
        update public.bookings
           set status             = 'confirmed',
               payment_status     = 'paid',
               payment_expires_at = null
         where id = v_booking.id;
      else
        -- La plata entró y el turno no se puede dar. El turno termina
        -- cancelado (si ya lo estaba, se queda) y se marca a devolver; la
        -- devolución la hace el dueño a mano. `payment_expires_at` se
        -- conserva: nada lo exige, y es el rastro de cuándo venció el hold.
        update public.bookings
           set status         = 'cancelled',
               payment_status = 'refund_due'
         where id = v_booking.id;
      end if;
      v_result := 'applied';

    else
      -- PLATA NO ESPERADA: el turno ya no espera pago. Cubre el cobro doble
      -- (ya estaba pagado por otro pago; el mismo pago reintentado no llega
      -- acá, lo frena el evento duplicado) y el turno que nunca pidió pago
      -- (p. ej. confirmado sin pago con la cuenta caída: sin link no hay dónde
      -- pagar, pero si igual entra, no se puede perder). El turno no cambia;
      -- ESE pago queda marcado para que el dueño lo devuelva.
      -- `booking_payments.status` es texto libre.
      v_row_status := 'refund_due';
      v_result := 'applied';
    end if;

  elsif p_status in ('refunded', 'charged_back') then
    -- Sólo la devolución del pago que PAGÓ el turno mueve al turno. La de un
    -- pago extra (anotado 'refund_due': cobro doble, plata no esperada)
    -- cierra su propia fila y nada más — devolver el sobrante no le quita el
    -- pago al turno. Una devolución de un pago que no conocemos no toca nada.
    select status into v_prev_row_status
      from public.booking_payments
     where mp_payment_id = p_mp_payment_id
       and booking_id = v_booking.id;

    if v_prev_row_status = 'refund_due' then
      v_result := 'applied';
    -- 'refund_due' en el TURNO también: es el camino principal de la
    -- devolución manual (el dueño devuelve desde Mercado Pago y el aviso
    -- cierra el "a devolver").
    elsif v_prev_row_status is not null
          and v_booking.payment_status in ('paid', 'refund_due') then
      update public.bookings
         set payment_status = 'refunded'
       where id = v_booking.id;
      v_result := 'applied';
    end if;

  elsif p_status in ('rejected', 'cancelled') then
    -- El turno no se toca: el hold sigue vivo hasta su vencimiento y el
    -- cliente puede volver a intentar. Sólo si el turno todavía espera pago
    -- cuenta como aplicado; si no, quedó el rastro y nada más.
    if v_booking.payment_status = 'awaiting' then
      v_result := 'applied';
    end if;
  end if;

  -- ----- El rastro del pago, siempre -----
  -- Por `mp_payment_id` si ya lo conocemos; si no, se vincula la fila que dejó
  -- la preferencia (T4) en vez de duplicar; si tampoco, se crea. El monto que
  -- se guarda es el que Mercado Pago dice que cobró.
  update public.booking_payments
     set status = v_row_status, amount_cents = p_amount_cents, currency = p_currency
   where mp_payment_id = p_mp_payment_id
     and booking_id = v_booking.id;
  get diagnostics v_found = row_count;

  if v_found = 0 then
    update public.booking_payments
       set mp_payment_id = p_mp_payment_id,
           status = v_row_status, amount_cents = p_amount_cents, currency = p_currency
     where id = (
       select id from public.booking_payments
        where booking_id = v_booking.id
          and mp_payment_id is null
          and mp_preference_id is not null
        order by created_at desc
        limit 1
     );
    get diagnostics v_found = row_count;
  end if;

  if v_found = 0 then
    insert into public.booking_payments (
      booking_id, tenant_id, mp_payment_id, status, amount_cents, currency
    )
    values (
      v_booking.id, p_tenant_id, p_mp_payment_id, v_row_status, p_amount_cents, p_currency
    );
  end if;

  return v_result;
end;
$$;

comment on function public.apply_booking_payment(uuid, uuid, text, text, int, text, timestamptz) is
  'Aplica un pago de Mercado Pago (ya re-leído por el servidor) sobre un turno '
  'del negocio. Idempotente por <payment_id>:<status>. Devuelve '
  'applied | duplicate | ignored.';

-- Ver la nota larga en `20260808120001_public_booking_throttle.sql`: hay que
-- revocar de los tres roles, o la función queda abierta.
revoke execute on function public.apply_booking_payment(uuid, uuid, text, text, int, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.apply_booking_payment(uuid, uuid, text, text, int, text, timestamptz)
  to service_role;
