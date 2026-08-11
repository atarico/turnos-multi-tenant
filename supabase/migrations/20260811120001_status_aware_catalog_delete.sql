-- ============================================================
-- Borrado de servicios y profesionales sujeto al estado del turno
--
-- El problema: hoy se puede borrar un servicio o un profesional aunque
-- tenga turnos agendados o ya completados. `service_id` corta con un
-- `23503` crudo (RESTRICT), pero `staff_id` está en CASCADE: borrar un
-- profesional se lleva puesta su historia entera de turnos. Ninguno de
-- los dos caminos le dice al dueño POR QUÉ no puede borrar, y el de
-- staff ni siquiera se lo impide.
--
-- La regla, igual para servicio y profesional: bloquear el borrado si
-- hay algún turno 'pending'/'confirmed' (agenda vigente) o 'completed'
-- (historial facturable). Sólo 'cancelled'/'no_show' no cuentan — esos
-- turnos se desvinculan y sobreviven al borrado con su nombre congelado.
--
-- Por qué la regla vive en la base y no en la app: es la misma razón que
-- `create_booking()` y `replace_staff_schedule()` ya documentan acá —
-- contar y borrar en dos pasos desde la app deja una ventana de
-- concurrencia. Acá la regla entera —contar, desvincular lo terminal,
-- borrar— vive en UNA transacción.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Snapshot del nombre en el turno (mismo patrón que price_cents/currency
--    en 20260804120001_booking_price_snapshot.sql)
--
-- El nombre de un turno pasado es un HECHO DEL PASADO: cómo se llamaba el
-- servicio/profesional cuando se reservó, no cómo se llama hoy. Sin esto,
-- borrar (o simplemente renombrar) un servicio degradaría el historial a
-- joins rotos o a un "—" genérico.
-- ------------------------------------------------------------
alter table public.bookings
  add column service_name text,
  add column staff_name   text;

-- Backfill: para los turnos que ya existen, el nombre actual es lo mejor
-- disponible — no hay registro de cuál era antes. Ambas FKs siguen NOT
-- NULL en este punto de la migración, así que todo turno tiene su
-- servicio y su profesional vivos y ninguna fila queda sin nombre.
update public.bookings b
   set service_name = s.name
  from public.services s
 where s.id = b.service_id;

update public.bookings b
   set staff_name = st.name
  from public.staff st
 where st.id = b.staff_id;

alter table public.bookings
  alter column service_name set not null,
  alter column staff_name   set not null;

-- ------------------------------------------------------------
-- 2. El snapshot se toma en un trigger, no dentro de create_booking()
--
-- Misma razón que snapshot_booking_price(): es una invariante de la
-- TABLA, no de una función puntual. Cualquier camino que cree un turno
-- (create_booking, create_public_booking, uno futuro) queda con el
-- nombre congelado sin tener que acordarse de copiarlo.
--
-- La regla completa (no sólo INSERT): el nombre se re-resuelve cuando la
-- FK CAMBIA A un valor no nulo — eso es una REASIGNACIÓN real (ej.
-- reschedule_booking() moviendo el turno a otro profesional), y el
-- nombre nuevo tiene que reflejar al profesional nuevo. El nombre NO se
-- toca en dos casos: si el profesional/servicio sólo se RENOMBRA (la FK
-- no cambió, es exactamente el snapshot que este migration existe para
-- proteger) y si la FK se pone en null por el camino de desvinculación
-- (delete_service/delete_staff sobre turnos cancelled/no_show) — ahí el
-- nombre congelado es el punto entero de la columna.
--
-- Por eso el trigger es `BEFORE INSERT OR UPDATE OF staff_id,
-- service_id`: sólo se dispara cuando esas columnas están en el SET, y
-- la función además compara contra el valor viejo antes de re-resolver.
-- ------------------------------------------------------------
create or replace function public.snapshot_booking_names()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_service_reassigned boolean;
  v_staff_reassigned   boolean;
begin
  v_service_reassigned := new.service_id is not null
    and (tg_op = 'INSERT' or new.service_id is distinct from old.service_id);
  v_staff_reassigned := new.staff_id is not null
    and (tg_op = 'INSERT' or new.staff_id is distinct from old.staff_id);

  if v_service_reassigned then
    select s.name into new.service_name
      from public.services s
     where s.id = new.service_id;

    if new.service_name is null then
      raise exception 'service_not_found' using errcode = 'foreign_key_violation';
    end if;
  end if;

  if v_staff_reassigned then
    select st.name into new.staff_name
      from public.staff st
     where st.id = new.staff_id;

    if new.staff_name is null then
      raise exception 'staff_not_found' using errcode = 'foreign_key_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger bookings_snapshot_names
  before insert or update of staff_id, service_id on public.bookings
  for each row execute function public.snapshot_booking_names();

-- ------------------------------------------------------------
-- 3. FKs nullables + staff_id pasa de CASCADE a RESTRICT
--
-- Nullable porque un turno 'cancelled'/'no_show' sobrevive al borrado de
-- su servicio/profesional desvinculado — el nombre congelado (arriba) es
-- lo único que necesita para seguir mostrándose.
--
-- staff_id en RESTRICT iguala el comportamiento que service_id ya tenía
-- desde 0003: la base rechaza el borrado directo (bypaseando la RPC) si
-- todavía hay turnos que lo referencian, en vez de arrastrarlos.
-- ------------------------------------------------------------
alter table public.bookings
  alter column service_id drop not null,
  alter column staff_id   drop not null;

-- El nombre de la FK de staff_id nunca se fijó a mano en 20260605120003
-- (fue un `references` inline), así que Postgres le puso el nombre por
-- default: bookings_staff_id_fkey. Igual no se asume ese nombre a ciegas
-- acá: se resuelve desde pg_constraint, así la migración no se rompe si
-- alguna vez alguien la renombra a mano.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum   = con.conkey[1]
   where con.contype   = 'f'
     and con.conrelid  = 'public.bookings'::regclass
     and con.confrelid = 'public.staff'::regclass
     and array_length(con.conkey, 1) = 1
     and att.attname   = 'staff_id';

  if v_conname is null then
    raise exception 'No se encontró la FK de bookings.staff_id hacia staff';
  end if;

  execute format('alter table public.bookings drop constraint %I', v_conname);
end;
$$;

alter table public.bookings
  add constraint bookings_staff_id_fkey
    foreign key (staff_id) references public.staff(id) on delete restrict;

-- ------------------------------------------------------------
-- 4. La invariante nueva: FK viva O turno terminal (y ya congelado)
--
-- Sin esto, nada impediría dejar un turno 'pending'/'confirmed' o
-- 'completed' con service_id/staff_id en null por fuera de las RPCs de
-- abajo — el backstop de la base tiene que valer para CUALQUIER camino
-- de escritura, no sólo el feliz.
-- ------------------------------------------------------------
alter table public.bookings
  add constraint bookings_service_link_or_terminal
    check (service_id is not null or status in ('cancelled', 'no_show')),
  add constraint bookings_staff_link_or_terminal
    check (staff_id is not null or status in ('cancelled', 'no_show'));

-- ------------------------------------------------------------
-- 5. Índice que faltaba: bookings(service_id) no existe hoy
--
-- Postgres nunca indexa solo las columnas hijas de una FK. Eso significa
-- que CUALQUIER DELETE de un servicio ya hacía seq-scan sobre bookings
-- para el chequeo RESTRICT, y el conteo nuevo de delete_service() haría
-- lo mismo. staff_id ya está cubierto por bookings_staff_starts_idx.
-- ------------------------------------------------------------
create index bookings_service_id_idx on public.bookings(service_id);

-- ------------------------------------------------------------
-- 6. Resultado del borrado como tipo, no como excepción
--
-- Mismo espíritu que booking_status: "bloqueado" es un resultado NORMAL
-- de intentar borrar, no un caso de error. PostgREST lo serializa como
-- un string plano — la app no necesita saber que es un enum.
-- ------------------------------------------------------------
create type public.delete_outcome as enum (
  'deleted', 'blocked_upcoming', 'blocked_history'
);

-- ------------------------------------------------------------
-- 7. delete_service() / delete_staff()
--
-- SECURITY INVOKER a propósito (a diferencia de replace_staff_schedule):
-- la función tiene que seguir SUJETA a la RLS de quien la llama, no
-- saltearla. El gate de tenant (`p_tenant_id`) es defensa en profundidad
-- explícita, igual que sum_monthly_revenue — no reemplaza la RLS, la
-- documenta en la firma.
--
-- El gate de ownership va PRIMERO y a propósito: nunca hay que contar ni
-- desvincular turnos de algo que ni siquiera podemos borrar.
--
-- No se repite el filtro de tenant en el conteo/desvinculación: el gate
-- de ownership YA es el guard de tenant explícito, y agregar
-- `tenant_id = p_tenant_id` en el COUNT sería activamente dañino —
-- podría esconder una fila que sí referencia el servicio/profesional y
-- convertir un bloqueo limpio en un 23503 crudo.
-- ------------------------------------------------------------
create or replace function public.delete_service(
  p_tenant_id  uuid,
  p_service_id uuid
)
returns public.delete_outcome
language plpgsql
security invoker set search_path = public
as $$
declare
  v_upcoming int;
  v_history  int;
begin
  perform 1 from public.services
   where id = p_service_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Servicio inexistente' using errcode = 'P0002';
  end if;

  select
    count(*) filter (where status in ('pending', 'confirmed')),
    count(*) filter (where status = 'completed')
    into v_upcoming, v_history
    from public.bookings
   where service_id = p_service_id;

  if v_upcoming > 0 then
    return 'blocked_upcoming';
  end if;

  if v_history > 0 then
    return 'blocked_history';
  end if;

  update public.bookings
     set service_id = null
   where service_id = p_service_id
     and status in ('cancelled', 'no_show');

  delete from public.services where id = p_service_id;

  return 'deleted';
end;
$$;

create or replace function public.delete_staff(
  p_tenant_id uuid,
  p_staff_id  uuid
)
returns public.delete_outcome
language plpgsql
security invoker set search_path = public
as $$
declare
  v_upcoming int;
  v_history  int;
begin
  perform 1 from public.staff
   where id = p_staff_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Profesional inexistente' using errcode = 'P0002';
  end if;

  select
    count(*) filter (where status in ('pending', 'confirmed')),
    count(*) filter (where status = 'completed')
    into v_upcoming, v_history
    from public.bookings
   where staff_id = p_staff_id;

  if v_upcoming > 0 then
    return 'blocked_upcoming';
  end if;

  if v_history > 0 then
    return 'blocked_history';
  end if;

  update public.bookings
     set staff_id = null
   where staff_id = p_staff_id
     and status in ('cancelled', 'no_show');

  delete from public.staff where id = p_staff_id;

  return 'deleted';
end;
$$;

-- OJO con esto (la trampa ya documentada en 20260808120001): Postgres le
-- da EXECUTE a PUBLIC por default en toda función nueva, y encima Supabase
-- via ALTER DEFAULT PRIVILEGES le da EXECUTE explícito a `anon` y
-- `authenticated`. Revocar de uno solo no alcanza — hay que revocar de
-- `public` Y `anon` antes de grantear sólo a `authenticated`. Estas dos
-- RPCs las llama el panel autenticado; anon nunca borra nada.
revoke execute on function public.delete_service(uuid, uuid) from public, anon;
grant  execute on function public.delete_service(uuid, uuid) to authenticated;

revoke execute on function public.delete_staff(uuid, uuid) from public, anon;
grant  execute on function public.delete_staff(uuid, uuid) to authenticated;
