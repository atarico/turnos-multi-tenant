-- ============================================================
-- 0006 — reschedule_booking()
--
-- Mueve un turno YA EXISTENTE a otra franja (y, si hace falta, a
-- otro profesional). Hasta acá el turno se creaba y quedaba fijo:
-- reprogramar significaba cancelar y volver a cargar todo a mano,
-- perdiendo el historial y los datos del cliente.
--
-- Es una RPC y no un UPDATE desde el panel por la MISMA razón que
-- create_booking() es una RPC: mover un turno tiene que revalidar
-- disponibilidad, solape y cupo, y hacerlo a prueba de concurrencia.
-- Un UPDATE suelto se saltearía el motor y permitiría doble-booking.
--
-- SECURITY DEFINER, con el aislamiento por tenant verificado ADENTRO
-- (auth_tenant_ids()), igual que replace_staff_schedule(). Sólo
-- authenticated: el cliente anónimo no reprograma (todavía no hay
-- forma de probar que el turno es suyo).
-- ============================================================
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_starts_at  timestamptz,
  p_staff_id   uuid default null
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  v_booking  public.bookings;
  v_tenant   public.tenants;
  v_service  public.services;
  v_staff    public.staff;
  v_staff_id uuid;
  v_ends_at  timestamptz;
  v_weekday  smallint;
  v_local_s  time;
  v_local_e  time;
  v_taken    int;
  v_others   int;
begin
  -- ----- Aislamiento: el turno tiene que ser de MI negocio -----
  select * into v_booking
    from public.bookings
    where id = p_booking_id
      and tenant_id in (select public.auth_tenant_ids());
  if not found then
    raise exception 'Turno inexistente' using errcode = 'P0002';
  end if;

  -- ----- Sólo se mueve un turno VIVO -----
  -- Reprogramar uno cancelado o ya cerrado lo resucitaría salteando
  -- el ciclo de vida. Para eso se crea un turno nuevo.
  if v_booking.status not in ('pending', 'confirmed') then
    raise exception 'Ese turno ya está cerrado' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_booking.tenant_id;

  -- El servicio NO cambia: cambiarlo cambia duración y precio, o sea
  -- es otro turno. Se lee para recalcular el fin de la franja.
  select * into v_service
    from public.services
    where id = v_booking.service_id;
  if not found then
    raise exception 'Servicio no disponible' using errcode = 'P0002';
  end if;

  -- ----- Profesional destino: el que venga, o el mismo de antes -----
  v_staff_id := coalesce(p_staff_id, v_booking.staff_id);

  select * into v_staff
    from public.staff
    where id = v_staff_id and tenant_id = v_booking.tenant_id and active;
  if not found then
    raise exception 'Profesional no disponible' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.staff_services
    where staff_id = v_staff_id and service_id = v_booking.service_id
  ) then
    raise exception 'Ese profesional no ofrece este servicio' using errcode = 'P0001';
  end if;

  -- ----- No se reprograma hacia el pasado -----
  if p_starts_at <= now() then
    raise exception 'Esa franja ya pasó' using errcode = 'P0001';
  end if;

  v_ends_at := p_starts_at + make_interval(mins => v_service.duration_min);

  -- ----- La franja nueva tiene que caer dentro de la disponibilidad -----
  v_weekday := extract(dow from (p_starts_at at time zone v_tenant.timezone))::smallint;
  v_local_s := (p_starts_at at time zone v_tenant.timezone)::time;
  v_local_e := (v_ends_at  at time zone v_tenant.timezone)::time;

  if not exists (
    select 1 from public.staff_availability a
    where a.staff_id = v_staff_id
      and a.weekday = v_weekday
      and a.start_time <= v_local_s
      and a.end_time   >= v_local_e
  ) then
    raise exception 'El profesional no atiende en ese horario' using errcode = 'P0001';
  end if;

  -- ----- Serializar las reservas del profesional DESTINO -----
  -- Sólo el destino: el profesional de origen queda MÁS libre al irse
  -- este turno, y liberar cupo no puede violar ninguna restricción.
  perform pg_advisory_xact_lock(hashtextextended(v_staff_id::text, 0));

  -- Ojo con el `id <> p_booking_id`: sin esa exclusión, el turno choca
  -- CONSIGO MISMO al moverse unos minutos dentro de su propia franja,
  -- y correr un turno de 10:00 a 10:15 sería imposible.
  select
    count(*) filter (where service_id = v_booking.service_id and starts_at = p_starts_at),
    count(*) filter (where not (service_id = v_booking.service_id and starts_at = p_starts_at))
  into v_taken, v_others
  from public.bookings
  where staff_id = v_staff_id
    and id <> p_booking_id
    and status in ('pending', 'confirmed')
    and starts_at < v_ends_at
    and ends_at   > p_starts_at;

  if v_others > 0 then
    raise exception 'El profesional ya tiene un turno en ese horario' using errcode = 'P0001';
  end if;

  if v_taken >= v_service.capacity then
    raise exception 'No quedan lugares en esa franja' using errcode = 'P0001';
  end if;

  -- ----- Mover -----
  -- El estado NO se toca: un turno confirmado sigue confirmado después
  -- de moverse. `updated_at` lo pone el trigger bookings_set_updated_at.
  update public.bookings
     set staff_id  = v_staff_id,
         starts_at = p_starts_at,
         ends_at   = v_ends_at
   where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$$;

-- Sólo el panel autenticado reprograma; anon nunca.
revoke execute on function public.reschedule_booking(uuid, timestamptz, uuid) from public;
grant execute on function public.reschedule_booking(uuid, timestamptz, uuid) to authenticated;
