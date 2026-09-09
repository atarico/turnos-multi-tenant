-- ============================================================
-- El recordatorio de mañana.
--
-- La confirmación (PR #68) es el REGISTRO: le deja al cliente constancia de
-- que reservó. Esto es la PALANCA: los no-shows son la economía de un negocio
-- de turnos, y avisar el día antes es lo único que los mueve.
--
-- Esta migración no manda nada. Contesta una sola pregunta —a quién hay que
-- recordarle— y deja marcado a quién ya se le recordó. El correo lo manda la
-- aplicación, que es donde vive el proveedor.
--
-- POR QUÉ EL "MAÑANA" SE CALCULA ACÁ Y NO EN TYPESCRIPT: "mañana" no es un
-- intervalo de horas, es una FECHA DE CALENDARIO, y cada negocio la tiene en
-- su propia zona. Un proceso que corra una vez por día y busque "turnos entre
-- 20 y 32 horas" acierta en la zona del servidor y se equivoca en las demás,
-- justo en los bordes del día — que es donde están los turnos de la mañana
-- temprano y los de la noche. Comparando fechas locales, la respuesta es
-- correcta para cada negocio sin importar a qué hora corra el proceso, siempre
-- que corra una vez durante el día de ese negocio.
--
-- LO QUE NO SE CHEQUEA, Y ES A PROPÓSITO: el plan del negocio. Un turno que ya
-- existe se honra aunque la suscripción haya vencido — es la misma decisión que
-- tomó 20260904120001 para la baja: se corta el COBRO, no el servicio ya
-- prestado. El cliente sacó turno y va a ir; dejarlo sin aviso lo castiga a él
-- por una deuda que no es suya. `tenant_takes_bookings()` gobierna los turnos
-- NUEVOS, no los que ya están tomados.
-- ============================================================

-- ------------------------------------------------------------
-- La marca de que a este turno ya se le avisó.
--
-- Nullable y sin default: la enorme mayoría de las filas nunca se recuerdan
-- —no dejaron mail, o se cargaron para hoy— y una columna que arranque llena
-- mentiría sobre lo que pasó.
--
-- Es la única defensa contra el aviso duplicado. El proceso corre una vez por
-- día, pero "una vez" es una intención, no una garantía: un reintento, un
-- despliegue en el medio o dos regiones ejecutando el mismo cron mandan el
-- mismo recordatorio dos veces, y el que lo recibe no piensa "qué prolijo",
-- piensa que el negocio está roto.
-- ------------------------------------------------------------
alter table public.bookings
  add column reminder_sent_at timestamptz;

comment on column public.bookings.reminder_sent_at is
  'Cuándo se le mandó el recordatorio al cliente. Null = todavía no. Es lo '
  'único que impide que un reintento del cron avise dos veces.';

-- El índice es PARCIAL sobre lo que la consulta realmente busca: los que
-- todavía no recibieron aviso. Los recordados se acumulan para siempre y no se
-- vuelven a mirar nunca, así que meterlos en el índice sería pagar espacio y
-- escritura por filas que ninguna consulta va a tocar.
create index bookings_pending_reminder_idx
  on public.bookings (starts_at)
  where reminder_sent_at is null;

-- ------------------------------------------------------------
-- A quién hay que recordarle mañana.
--
-- Devuelve TODO lo que el mail necesita en una sola consulta. La alternativa
-- —traer ids y después resolver nombres uno por uno— son tres viajes por
-- turno contra una base que está del otro lado de la red, dentro de un proceso
-- que tiene minutos y no horas.
--
-- Los cuatro filtros, y qué pasa sin cada uno:
--
--   · `status in ('pending','confirmed')` — un turno cancelado no se recuerda,
--     y recordarle a alguien que "mañana te esperamos" después de que canceló
--     es el peor mail que este sistema podría mandar.
--   · `customer_email is not null` — el campo es opcional en el formulario
--     público y la mayoría de las reservas no lo trae.
--   · `reminder_sent_at is null` — la defensa contra el duplicado.
--   · la comparación de fechas locales — el corazón, explicado arriba.
--
-- `p_limit` existe para que un día raro no convierta una corrida en algo que
-- no termina. Si alguna vez recorta de verdad, el resto queda sin marcar y se
-- lo lleva la corrida siguiente — que para entonces ya será tarde, así que el
-- límite está puesto MUY por encima de cualquier día plausible: es un fusible,
-- no una política.
--
-- `security definer` y grant sólo a `service_role`: cruza los turnos de TODOS
-- los negocios, con nombre y mail de sus clientes. Es exactamente lo que
-- 20260908120001 le acaba de sacar al operador de plataforma, así que no puede
-- quedar al alcance de una sesión. La llama el cron desde el servidor.
-- ------------------------------------------------------------
create or replace function public.bookings_due_for_reminder(
  p_limit int default 500
)
returns table (
  booking_id     uuid,
  tenant_name    text,
  timezone       text,
  service_name   text,
  staff_name     text,
  starts_at      timestamptz,
  customer_name  text,
  customer_email text
)
language sql
stable
security definer set search_path = public
as $$
  select
    b.id,
    t.name,
    t.timezone,
    s.name,
    st.name,
    b.starts_at,
    b.customer_name,
    b.customer_email
  from public.bookings b
  join public.tenants  t  on t.id  = b.tenant_id
  join public.services s  on s.id  = b.service_id
  -- `left join`: el profesional puede no estar asignado, y eso no es motivo
  -- para dejar a alguien sin recordatorio. El mail omite esa línea.
  left join public.staff st on st.id = b.staff_id
  where b.status in ('pending', 'confirmed')
    and b.customer_email is not null
    and b.reminder_sent_at is null
    and (b.starts_at at time zone t.timezone)::date
        = ((now() at time zone t.timezone)::date + 1)
  order by b.starts_at
  limit p_limit;
$$;

comment on function public.bookings_due_for_reminder(int) is
  'Los turnos de MAÑANA que todavía no recibieron recordatorio, con todo lo '
  'que el mail necesita. El "mañana" se calcula en la zona de cada negocio.';

revoke execute on function public.bookings_due_for_reminder(int)
  from public, anon, authenticated;
grant  execute on function public.bookings_due_for_reminder(int) to service_role;

-- ------------------------------------------------------------
-- Marcar que a este turno ya se le avisó.
--
-- Se llama DESPUÉS de que el proveedor aceptó el correo, y de a uno. Marcar
-- todo el lote antes de mandar sería más barato en viajes y perdería
-- exactamente lo que hay que conservar: si el proceso se muere a la mitad, los
-- que ya salieron quedan marcados y los que no, no. Al revés —marcar primero—
-- un corte deja a medio lote sin aviso y marcado como avisado, que es el único
-- fallo de este sistema que nadie puede detectar después.
--
-- Devuelve boolean para que quien llama pueda distinguir "marqué" de "no
-- existe esa fila", en vez de suponer.
-- ------------------------------------------------------------
create or replace function public.mark_booking_reminded(p_booking_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_updated int;
begin
  update public.bookings
     set reminder_sent_at = now()
   where id = p_booking_id
     and reminder_sent_at is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function public.mark_booking_reminded(uuid) is
  'Marca el recordatorio como enviado. Se llama DESPUÉS de que el proveedor '
  'aceptó el correo, de a un turno. Devuelve false si la fila no existía o ya '
  'estaba marcada.';

revoke execute on function public.mark_booking_reminded(uuid)
  from public, anon, authenticated;
grant  execute on function public.mark_booking_reminded(uuid) to service_role;
