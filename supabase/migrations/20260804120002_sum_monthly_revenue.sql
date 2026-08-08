-- ============================================================
-- Ingresos del mes: la suma la hace Postgres, no la app
--
-- La primera versión traía las filas y sumaba en JavaScript. Eso se rompe
-- solo: PostgREST corta la respuesta en `max_rows` (1000, ver
-- supabase/config.toml) y NO avisa con un error — el recorte viaja en el
-- header `Content-Range`. Un negocio con más de 1000 turnos completados en el
-- mes habría visto ingresos por debajo de lo real, en silencio y con cara de
-- dato bueno.
--
-- Sumar en la base saca el problema de raíz: vuelve una fila por moneda,
-- nunca mil.
--
-- `security invoker` a propósito: la función tiene que quedar SUJETA a las
-- políticas RLS de `bookings`, no saltárselas. El aislamiento por negocio lo
-- sigue dando RLS más el filtro explícito por `p_tenant_id`.
--
-- El agrupado por moneda no es decoración: si un negocio llegara a tener
-- servicios en dos monedas, sumar todo junto daría un número sin significado.
-- Devolvemos una fila por moneda y que decida quien llama.
-- ============================================================
create or replace function public.sum_monthly_revenue(
  p_tenant_id uuid,
  p_start     timestamptz,
  p_end       timestamptz
)
returns table (total_cents bigint, currency text)
language sql
stable
security invoker
set search_path = public
as $$
  select sum(b.price_cents)::bigint, b.currency
    from public.bookings b
   where b.tenant_id = p_tenant_id
     and b.status    = 'completed'
     and b.starts_at >= p_start
     and b.starts_at <  p_end
   group by b.currency;
$$;
