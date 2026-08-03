-- ============================================================
-- 0005 — replace_staff_schedule()
--
-- Reemplazo ATÓMICO del horario semanal de un profesional. Hasta
-- acá el panel hacía DELETE + INSERT en dos llamadas: si el INSERT
-- fallaba, el profesional quedaba SIN horario (y sin franjas en la
-- página pública). Esta función hace las dos cosas en una sola
-- transacción, estilo create_booking(): o entra la semana entera,
-- o queda la anterior intacta.
--
-- SECURITY DEFINER porque toca staff_availability salteando la RLS;
-- por eso el aislamiento por tenant se verifica ADENTRO: el staff
-- tiene que pertenecer a un negocio del que soy miembro
-- (auth_tenant_ids()). Sólo authenticated puede ejecutarla.
-- ============================================================
create or replace function public.replace_staff_schedule(
  p_staff_id uuid,
  p_windows  jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_window  jsonb;
  v_weekday int;
  v_start   time;
  v_end     time;
begin
  -- ----- Aislamiento: el profesional tiene que ser de MI negocio -----
  if not exists (
    select 1 from public.staff s
    where s.id = p_staff_id
      and s.tenant_id in (select public.auth_tenant_ids())
  ) then
    raise exception 'Profesional inexistente' using errcode = 'P0002';
  end if;

  if p_windows is null or jsonb_typeof(p_windows) <> 'array' then
    raise exception 'Horario inválido' using errcode = 'P0001';
  end if;

  -- ----- Validar TODAS las franjas antes de tocar nada -----
  -- La tabla ya tiene checks (weekday 0-6, end > start), pero validar
  -- acá corta antes del DELETE y con un error claro.
  for v_window in select * from jsonb_array_elements(p_windows) loop
    v_weekday := (v_window->>'weekday')::int;
    if v_weekday is null or v_weekday < 0 or v_weekday > 6 then
      raise exception 'Día de la semana inválido' using errcode = 'P0001';
    end if;

    begin
      v_start := (v_window->>'start_time')::time;
      v_end   := (v_window->>'end_time')::time;
    exception when others then
      raise exception 'Hora inválida' using errcode = 'P0001';
    end;

    if v_start is null or v_end is null or v_end <= v_start then
      raise exception 'Cada franja tiene que terminar después de empezar'
        using errcode = 'P0001';
    end if;
  end loop;

  -- ----- Reemplazo atómico: mismo statement lifecycle, misma tx -----
  delete from public.staff_availability where staff_id = p_staff_id;

  insert into public.staff_availability (staff_id, weekday, start_time, end_time)
  select
    p_staff_id,
    (w->>'weekday')::int,
    (w->>'start_time')::time,
    (w->>'end_time')::time
  from jsonb_array_elements(p_windows) as w;
end;
$$;

-- Sólo el panel autenticado gestiona horarios; anon nunca.
revoke execute on function public.replace_staff_schedule(uuid, jsonb) from public;
grant execute on function public.replace_staff_schedule(uuid, jsonb) to authenticated;
