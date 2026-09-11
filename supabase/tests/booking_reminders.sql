-- ============================================================
-- Test SQL para 20260909120001_booking_reminders.sql
--
-- Misma convención que `cancel_subscription.sql`: assertions con
-- `do $$ ... raise exception ... $$`, cada bloque arma sus datos, todo en una
-- transacción con ROLLBACK.
--
-- Lo que este archivo defiende, que es lo que un test feliz no ve:
--
-- 1. QUE EL "MAÑANA" SEA EL DE CADA NEGOCIO, y no una ventana de horas. Los
--    casos 6 y 7 son la razón de existir de la función: dos negocios a doce
--    horas de distancia, cada uno con SU mañana local.
--
--    Sobre la alternativa tentadora —"turnos entre 20 y 32 horas"— conviene
--    ser preciso, porque al probarla se ve mejor el problema: no falla en un
--    caso concreto, falla SEGÚN LA HORA A LA QUE SE CORRA. Un turno de mañana
--    a las 15 está a 20 horas si el proceso corre a las 19 y a 30 si corre a
--    las 9, y la ventana lo agarra o no según eso. Comparar fechas locales da
--    la misma respuesta corra a la hora que corra, que es lo que un proceso
--    diario necesita.
--
-- 2. QUE NO SE LE AVISE AL QUE CANCELÓ. El caso 3. Es el peor mail que este
--    sistema puede mandar: "mañana te esperamos" a alguien que canceló.
--
-- 3. QUE NADIE RECIBA EL AVISO DOS VECES. Los casos 4 y 9. Un reintento del
--    cron, un despliegue en el medio o dos regiones corriendo lo mismo alcanzan
--    para duplicar, y el que lo recibe no piensa "qué prolijo".
--
-- 4. QUE EL TURNO YA TOMADO SE HONRE AUNQUE EL PLAN HAYA VENCIDO. El caso 8.
--    Es la misma decisión de 20260904120001: se corta el cobro, no lo ya
--    prestado. Castigar al cliente por la deuda del negocio es castigar a quien
--    no debe.
--
-- 5. QUE NO SE FILTRE A UNA SESIÓN. El caso 10 corre con `set local role`. La
--    función cruza turnos de TODOS los negocios con nombre y mail de sus
--    clientes — justo lo que 20260908120001 le sacó al operador.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/booking_reminders.sql
-- ============================================================

\set ON_ERROR_STOP on

begin;

-- ------------------------------------------------------------
-- Andamio: dos negocios en husos MUY distintos, con servicio y profesional.
--
-- Buenos Aires (UTC-3) y Tokio (UTC+9): doce horas de diferencia, suficiente
-- para que un mismo instante caiga en días de calendario distintos. Es el par
-- que hace posibles los casos 6 y 7.
-- ------------------------------------------------------------
create temporary table t_ids (
  clave text primary key, tenant_id uuid, service_id uuid, staff_id uuid
) on commit drop;

do $$
declare
  v_t uuid; v_s uuid; v_st uuid;
begin
  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Sur', 'rec-sur', 'pro', 'AR', 'America/Argentina/Buenos_Aires')
    returning id into v_t;
  insert into public.services (tenant_id, name, duration_min)
    values (v_t, 'Corte', 30) returning id into v_s;
  insert into public.staff (tenant_id, name) values (v_t, 'Ana') returning id into v_st;
  insert into t_ids values ('sur', v_t, v_s, v_st);

  insert into public.tenants (name, slug, plan, country, timezone)
    values ('Este', 'rec-este', 'pro', 'AR', 'Asia/Tokyo')
    returning id into v_t;
  insert into public.services (tenant_id, name, duration_min)
    values (v_t, 'Masaje', 60) returning id into v_s;
  insert into public.staff (tenant_id, name) values (v_t, 'Kenji') returning id into v_st;
  insert into t_ids values ('este', v_t, v_s, v_st);
end $$;

-- ------------------------------------------------------------
-- Pone UN turno y devuelve su id.
--
-- `p_local_day_offset` es el parámetro que importa: cuántos días DESPUÉS de
-- hoy —en la zona del negocio— cae el turno. 1 es mañana. Se arma desde la
-- fecha local justamente para no depender de a qué hora se corra el test.
-- ------------------------------------------------------------
create or replace function pg_temp.put_booking(
  p_clave         text,
  p_local_day_offset int default 1,
  p_hour          int default 15,
  p_status        text default 'confirmed',
  p_email         text default 'cliente@correo.com',
  p_with_staff    boolean default true
) returns uuid language plpgsql as $$
declare
  v record;
  v_tz text;
  v_starts timestamptz;
  v_id uuid;
begin
  select * into v from t_ids where clave = p_clave;
  select timezone into v_tz from public.tenants where id = v.tenant_id;

  -- La hora local del día pedido, traducida al instante absoluto que le
  -- corresponde en esa zona.
  v_starts := (((now() at time zone v_tz)::date + p_local_day_offset)
               + make_interval(hours => p_hour)) at time zone v_tz;

  insert into public.bookings (
    tenant_id, staff_id, service_id, starts_at, ends_at,
    status, customer_name, customer_email
  ) values (
    v.tenant_id,
    case when p_with_staff then v.staff_id else null end,
    v.service_id,
    v_starts, v_starts + interval '30 minutes',
    p_status::public.booking_status, 'Marcos', p_email
  ) returning id into v_id;

  return v_id;
end $$;

-- No hay helper que envuelva a la función: `returns table(...)` NO crea un
-- tipo compuesto con nombre, así que `setof public.bookings_due_for_reminder`
-- no existe. Se la llama directo, que además deja a la vista qué se prueba.
create or replace function pg_temp.due_count() returns int
language sql as $$ select count(*)::int from public.bookings_due_for_reminder(); $$;

-- ------------------------------------------------------------
-- Caso 1: un turno de mañana con mail entra en la lista.
-- ------------------------------------------------------------
do $$
declare v_id uuid; v_n int;
begin
  delete from public.bookings;
  v_id := pg_temp.put_booking('sur');

  select count(*) into v_n from public.bookings_due_for_reminder() where booking_id = v_id;

  if v_n <> 1 then
    raise exception 'CASO 1: el turno de mañana no salió en la lista (% filas)', v_n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 2: y trae TODO lo que el mail necesita, resuelto.
--
-- Va aparte del caso 1: una función que devuelva el id correcto con los
-- nombres en null pasa aquél y deja el mail sin contenido.
-- ------------------------------------------------------------
do $$
declare r record;
begin
  delete from public.bookings;
  perform pg_temp.put_booking('sur');

  select * into r from public.bookings_due_for_reminder() limit 1;

  if r.tenant_name is distinct from 'Sur'    then raise exception 'CASO 2: negocio %', r.tenant_name; end if;
  if r.service_name is distinct from 'Corte' then raise exception 'CASO 2: servicio %', r.service_name; end if;
  if r.staff_name is distinct from 'Ana'     then raise exception 'CASO 2: profesional %', r.staff_name; end if;
  if r.customer_email is distinct from 'cliente@correo.com' then
    raise exception 'CASO 2: mail %', r.customer_email;
  end if;
  if r.timezone is distinct from 'America/Argentina/Buenos_Aires' then
    raise exception 'CASO 2: zona %', r.timezone;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 3: EL PEOR MAIL POSIBLE. Un turno cancelado no se recuerda.
-- ------------------------------------------------------------
do $$
declare v_n int;
begin
  delete from public.bookings;
  perform pg_temp.put_booking('sur', 1, 15, 'cancelled');

  v_n := pg_temp.due_count();

  if v_n <> 0 then
    raise exception 'CASO 3: se le iba a recordar a alguien que canceló';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 4: al que ya se le avisó, no se le avisa de nuevo.
-- ------------------------------------------------------------
do $$
declare v_id uuid; v_n int;
begin
  delete from public.bookings;
  v_id := pg_temp.put_booking('sur');

  if not public.mark_booking_reminded(v_id) then
    raise exception 'CASO 4: mark_booking_reminded devolvió false sobre una fila fresca';
  end if;

  v_n := pg_temp.due_count();

  if v_n <> 0 then
    raise exception 'CASO 4: el turno ya recordado volvió a salir en la lista';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 5: sin mail no hay a dónde escribir.
-- ------------------------------------------------------------
do $$
begin
  delete from public.bookings;
  perform pg_temp.put_booking('sur', 1, 15, 'confirmed', null);

  if pg_temp.due_count() <> 0 then
    raise exception 'CASO 5: salió un turno sin mail del cliente';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 6: EL CASO QUE DEFINE LA FUNCIÓN.
--
-- Dos negocios, doce horas de diferencia, y CADA UNO con su turno de mañana
-- local. Los dos tienen que salir, aunque sus instantes UTC estén a medio día
-- uno del otro.
-- ------------------------------------------------------------
do $$
declare v_sur uuid; v_este uuid; v_n int;
begin
  delete from public.bookings;
  v_sur  := pg_temp.put_booking('sur',  1, 15);
  v_este := pg_temp.put_booking('este', 1, 15);

  select count(*) into v_n from public.bookings_due_for_reminder()
   where booking_id in (v_sur, v_este);

  if v_n <> 2 then
    raise exception
      'CASO 6: con dos negocios en husos distintos salieron % de 2 turnos de mañana', v_n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 7: Y EL ESPEJO, que es el que atrapa la implementación por horas.
--
-- El turno de PASADO MAÑANA local no sale, aunque en horas absolutas pueda
-- caer cerca del de mañana de la otra zona. Sin este caso, una función que
-- busque "entre 20 y 32 horas" pasa el caso 6 y avisa con un día de más.
-- ------------------------------------------------------------
do $$
declare v_hoy uuid; v_pasado uuid; v_n int;
begin
  delete from public.bookings;
  v_hoy    := pg_temp.put_booking('sur', 0, 23);  -- hoy a la noche
  v_pasado := pg_temp.put_booking('sur', 2, 8);   -- pasado mañana temprano

  select count(*) into v_n from public.bookings_due_for_reminder()
   where booking_id in (v_hoy, v_pasado);

  if v_n <> 0 then
    raise exception
      'CASO 7: salieron % turnos que NO son de mañana (hoy o pasado mañana)', v_n;
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 8: el turno ya tomado se honra aunque el plan haya vencido.
--
-- Misma decisión que 20260904120001 tomó para la baja: se corta el cobro, no
-- lo ya prestado. El cliente sacó turno y va a ir; dejarlo sin aviso lo
-- castiga a él por una deuda que no es suya.
-- ------------------------------------------------------------
do $$
declare v record; v_id uuid;
begin
  delete from public.bookings;
  select * into v from t_ids where clave = 'sur';

  delete from public.subscriptions where tenant_id = v.tenant_id;
  insert into public.subscriptions (
    tenant_id, plan, status, current_period_start, current_period_end, price_usd_cents
  ) values (
    v.tenant_id, 'pro', 'canceled',
    now() - interval '60 days', now() - interval '3 days', 0
  );

  if public.tenant_takes_bookings(v.tenant_id) then
    raise exception 'CASO 8: el fixture no dejó al negocio congelado; el test no probaría nada';
  end if;

  v_id := pg_temp.put_booking('sur');

  if pg_temp.due_count() <> 1 then
    raise exception 'CASO 8: el plan vencido dejó al CLIENTE sin su recordatorio';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 9: marcar dos veces devuelve false la segunda.
--
-- Quien llama tiene que poder distinguir "marqué" de "ya estaba", en vez de
-- suponer. Es lo que le permite al proceso detectar que otra corrida se le
-- adelantó en vez de mandar el mail igual.
-- ------------------------------------------------------------
do $$
declare v_id uuid;
begin
  delete from public.bookings;
  v_id := pg_temp.put_booking('sur');

  perform public.mark_booking_reminded(v_id);

  if public.mark_booking_reminded(v_id) then
    raise exception 'CASO 9: marcar dos veces devolvió true la segunda';
  end if;

  if public.mark_booking_reminded(gen_random_uuid()) then
    raise exception 'CASO 9: marcar un turno inexistente devolvió true';
  end if;
end $$;

-- ------------------------------------------------------------
-- Caso 10: NADA DE ESTO ESTÁ AL ALCANCE DE UNA SESIÓN.
--
-- La función cruza los turnos de TODOS los negocios con nombre y mail de sus
-- clientes. Es exactamente lo que 20260908120001 le acaba de sacar al operador
-- de plataforma; dejarla grantada a `authenticated` sería devolvérselo por la
-- puerta de al lado, y a cualquier dueño logueado además.
--
-- Corre con `set local role`: sin eso el test es superusuario y no prueba un
-- solo permiso.
-- ------------------------------------------------------------
do $$
begin
  set local role authenticated;

  begin
    perform public.bookings_due_for_reminder();
    reset role;
    raise exception
      'CASO 10: `authenticated` leyó los turnos de todos los negocios.';
  exception
    when insufficient_privilege then reset role;
    when others then reset role; raise;
  end;
end $$;

do $$
begin
  set local role authenticated;

  begin
    perform public.mark_booking_reminded(gen_random_uuid());
    reset role;
    raise exception
      'CASO 10: `authenticated` pudo marcar recordatorios ajenos.';
  exception
    when insufficient_privilege then reset role;
    when others then reset role; raise;
  end;
end $$;

rollback;
