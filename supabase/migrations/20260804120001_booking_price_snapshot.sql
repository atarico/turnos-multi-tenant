-- ============================================================
-- Snapshot del precio en el turno
--
-- Hasta acá el precio de un turno se leía haciendo join a
-- `services.price_cents`, o sea al precio de HOY. Eso hace que el
-- historial de ingresos se reescriba solo: subir la lista de precios en
-- septiembre revaluaba todos los turnos de marzo. Una métrica contable no
-- puede depender de un dato mutable.
--
-- El precio de un turno es un HECHO DEL PASADO: lo que se acordó cuando
-- se reservó. Se congela en la fila.
-- ============================================================

alter table public.bookings
  add column price_cents integer,
  add column currency    text;

-- Backfill: para los turnos que ya existen, el precio actual del servicio es
-- lo mejor disponible — no hay registro de cuál era antes. `service_id` es
-- `on delete restrict`, así que todo turno tiene su servicio vivo y ninguna
-- fila queda sin precio.
update public.bookings b
   set price_cents = s.price_cents,
       currency    = s.currency
  from public.services s
 where s.id = b.service_id;

alter table public.bookings
  alter column price_cents set not null,
  alter column currency    set not null;

alter table public.bookings
  add constraint bookings_price_non_negative check (price_cents >= 0);

-- ------------------------------------------------------------
-- El snapshot se toma en un trigger, no dentro de create_booking()
--
-- Por qué el trigger y no el INSERT de create_booking(): la invariante es de
-- la TABLA, no de una función. Cualquier camino que cree un turno tiene que
-- quedar con su precio congelado, y así no depende de que cada función nueva
-- se acuerde de copiarlo.
--
-- Usa `coalesce`, no asignación directa: si algún día se quiere reservar con
-- un precio distinto al de lista (descuento, promoción), basta con mandarlo
-- explícito y el trigger lo respeta.
-- ------------------------------------------------------------
create or replace function public.snapshot_booking_price()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_service public.services;
begin
  if new.price_cents is not null and new.currency is not null then
    return new;
  end if;

  select * into v_service
    from public.services
   where id = new.service_id;

  if not found then
    raise exception 'service_not_found' using errcode = 'foreign_key_violation';
  end if;

  new.price_cents = coalesce(new.price_cents, v_service.price_cents);
  new.currency    = coalesce(new.currency,    v_service.currency);

  return new;
end;
$$;

create trigger bookings_snapshot_price
  before insert on public.bookings
  for each row execute function public.snapshot_booking_price();

-- Índice para la métrica de ingresos: filtra por negocio, estado y ventana de
-- tiempo. Parcial sobre 'completed' porque es lo único que suma.
create index bookings_tenant_completed_starts_idx
  on public.bookings(tenant_id, starts_at)
  where status = 'completed';
