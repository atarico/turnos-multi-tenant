-- ============================================================
-- Freno al spam de reservas anónimas
--
-- El problema: `create_booking()` estaba grantada a `anon`, y la
-- NEXT_PUBLIC_SUPABASE_ANON_KEY viaja al browser por definición. O sea que
-- cualquiera podía pegarle a PostgREST DIRECTO, sin pasar por la app, y llenar
-- la agenda de cualquier negocio de la plataforma con turnos falsos. El dueño
-- abría el panel y veía basura; los clientes reales veían "sin lugares".
--
-- Por qué el orden importa: poner rate limiting en la app SIN revocarle el
-- grant a `anon` no sirve para nada, porque el atacante nunca pasa por la app.
-- Primero se cierra la puerta de atrás, después se pone el freno.
--
--   1. Se le revoca `create_booking()` a `anon`. Quedan dos caminos:
--      `authenticated` (el panel carga turnos a mano) y `service_role`
--      (nuestro servidor, para el visitante anónimo).
--   2. La reserva pública pasa ahora por `create_public_booking()`, que cuenta
--      cuántas reservas hizo esa IP en la última hora antes de dejar pasar.
--
-- El contador vive en Postgres y no en memoria del proceso a propósito: en
-- serverless cada request puede caer en una instancia distinta, así que un
-- contador en memoria cuenta hasta uno y se olvida.
-- ============================================================

-- ------------------------------------------------------------
-- Se guarda un HASH de la IP, nunca la IP
--
-- Para frenar abuso alcanza con poder contar; no hace falta saber de dónde
-- viene la gente. La IP cruda es un dato personal y además termina en backups
-- y en dumps. El hash lo calcula la app con un salt propio: sin salt, el
-- espacio de IPv4 son 4 mil millones de valores y cualquiera con acceso de
-- lectura reconstruye la tabla entera por fuerza bruta en un rato.
-- ------------------------------------------------------------
create table public.booking_attempts (
  id         bigint generated always as identity primary key,
  ip_hash    text        not null,
  created_at timestamptz not null default now()
);

create index booking_attempts_ip_recent_idx
  on public.booking_attempts (ip_hash, created_at desc);

-- Nadie llega a esta tabla desde el cliente: sólo la tocan funciones DEFINER.
-- RLS prendida sin una sola policy = puerta tapiada, no puerta abierta.
alter table public.booking_attempts enable row level security;

-- ------------------------------------------------------------
-- La reserva del visitante anónimo, con freno
--
-- Sólo `service_role` puede ejecutarla, o sea únicamente nuestro servidor. Es
-- lo que hace que el `p_ip_hash` valga algo: si el cliente pudiera llamarla,
-- mandaría un hash distinto en cada intento y el contador no contaría nada.
--
-- Qué cuenta y qué no: el intento se registra en la MISMA transacción que la
-- reserva, así que si `create_booking()` rechaza (franja ocupada, sin cupo)
-- todo se revierte y ese intento no suma. Es deliberado: lo que protegemos es
-- la agenda, y una reserva rechazada no ensucia nada.
-- ------------------------------------------------------------
create or replace function public.create_public_booking(
  p_tenant_slug    text,
  p_staff_id       uuid,
  p_service_id     uuid,
  p_starts_at      timestamptz,
  p_customer_name  text,
  p_ip_hash        text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_notes          text default null
)
returns public.bookings
language plpgsql
security definer set search_path = public
as $$
declare
  -- Una IP honesta reservando para su familia no llega a 5 turnos en una hora;
  -- un script sí, y en el primer minuto.
  c_max_per_hour constant int := 5;
  v_recent       int;
  v_booking      public.bookings;
begin
  if p_ip_hash is null or length(trim(p_ip_hash)) = 0 then
    raise exception 'Origen no identificado' using errcode = 'P0001';
  end if;

  -- Serializar los intentos de ESTE origen antes de contarlos.
  --
  -- Sin el lock el freno no frena: contar y después insertar son dos pasos, y
  -- entre uno y otro entra cualquiera. Dos requests simultáneas leen las dos
  -- "van 4" y pasan las dos; cien requests en paralelo leen las cien "van 0" y
  -- pasan las cien. O sea que frenaría a una persona y no a un script, que es
  -- exactamente el atacante contra el que existe esto.
  --
  -- Mismo primitivo que usa `create_booking()` para el cupo, un nivel más
  -- arriba. El orden de toma es siempre origen → profesional, nunca al revés,
  -- así que no se puede armar un ciclo entre los dos locks.
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 0));

  select count(*) into v_recent
    from public.booking_attempts
   where ip_hash = p_ip_hash
     and created_at > now() - interval '1 hour';

  if v_recent >= c_max_per_hour then
    raise exception 'Demasiadas reservas seguidas' using errcode = 'P0001';
  end if;

  insert into public.booking_attempts (ip_hash) values (p_ip_hash);

  v_booking := public.create_booking(
    p_tenant_slug,
    p_staff_id,
    p_service_id,
    p_starts_at,
    p_customer_name,
    p_customer_email,
    p_customer_phone,
    p_notes
  );

  -- Higiene: las filas viejas ya no deciden nada. Se limpian acá y no con un
  -- cron para no sumar infraestructura por una tabla que se poda sola.
  delete from public.booking_attempts
   where created_at < now() - interval '1 day';

  return v_booking;
end;
$$;

-- ------------------------------------------------------------
-- Cerrar la puerta de atrás
--
-- OJO con esto, que es la trampa entera: Postgres le da EXECUTE a PUBLIC por
-- defecto en toda función nueva (al revés que con las tablas), y `anon` hereda
-- de PUBLIC. Revocarle sólo a `anon` saca el grant explícito y NO SIRVE DE
-- NADA: sigue entrando por PUBLIC. Hay que revocar de los dos.
--
-- El patrón correcto ya estaba en este repo: ver
-- `20260802120001_replace_staff_schedule.sql:79` y
-- `20260803120001_reschedule_booking.sql:149`, que revocan de `public` antes de
-- grantear. La migration que creó `create_booking()` es la que no lo hizo.
--
-- En `create_public_booking()` el descuido sería todavía peor que en
-- `create_booking()`: el `p_ip_hash` lo manda quien llama, así que un anónimo
-- que pudiera ejecutarla directo mandaría un hash distinto en cada request y el
-- freno no contaría nada. El freno sólo vale si la única puerta es el servidor.
--
-- Y hay una segunda trampa, propia de Supabase, encima de la de PUBLIC:
-- `ALTER DEFAULT PRIVILEGES` del proyecto le da EXECUTE EXPLÍCITO a `anon` y
-- `authenticated` en cada función nueva del schema public. O sea que revocar
-- de `public` acá NO alcanza: `anon` no entra heredando de PUBLIC, entra por
-- su propio grant. Hay que revocar de los tres. Verificado contra la base:
-- con `from public` solo, `anon` seguía ejecutando la función.
-- ------------------------------------------------------------
revoke execute on function public.create_booking(
  text, uuid, uuid, timestamptz, text, text, text, text
) from public, anon;

revoke execute on function public.create_public_booking(
  text, uuid, uuid, timestamptz, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.create_public_booking(
  text, uuid, uuid, timestamptz, text, text, text, text, text
) to service_role;
