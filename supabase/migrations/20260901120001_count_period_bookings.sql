-- ============================================================
-- El techo de turnos del período.
--
-- El conteo lo hace Postgres y no la app, por lo mismo que
-- `sum_monthly_revenue`: traer las filas y contarlas del lado de Node se
-- rompe contra el `max_rows` de PostgREST, que recorta la respuesta en 1000
-- filas SIN devolver error. Un negocio con más turnos que ese tope habría
-- mostrado un número menor al real, en silencio — y acá ese número es
-- justamente el que decide si se le avisa o no.
--
-- Se cuenta por `created_at` y NO por `starts_at`. El techo existe para ver
-- abuso: contando por la fecha del turno, cargar cincuenta mil turnos con
-- fecha del año que viene no topearía ningún período nunca, que es el caso
-- más obvio que hay que ver. Contar por carga puede avisar de más; no contar
-- por carga no avisa nunca, y este aviso NO bloquea a nadie, así que los dos
-- errores no cuestan lo mismo.
--
-- Por el mismo motivo NO se filtra por estado: un turno cancelado ya ocupó su
-- fila y ya consumió sistema. Cancelarlo después no devuelve lo gastado.
-- ============================================================

-- `security invoker`: el aislamiento lo pone la RLS de `bookings`, que es la
-- misma que ya protege al resto del panel. Con `security definer` esta
-- función se saltearía la policy y contaría los turnos de cualquier negocio
-- con sólo pasarle otro uuid.
create or replace function public.count_period_bookings(
  p_tenant_id uuid,
  p_start     timestamptz,
  p_end       timestamptz
)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::bigint
    from public.bookings b
   where b.tenant_id  = p_tenant_id
     and b.created_at >= p_start
     and b.created_at <  p_end;
$$;

-- Los índices que ya existen son por `starts_at`; contar por `created_at`
-- sin este índice obliga a recorrer todos los turnos del negocio en cada
-- carga del panel.
create index if not exists bookings_tenant_created_idx
  on public.bookings(tenant_id, created_at);

comment on function public.count_period_bookings(uuid, timestamptz, timestamptz) is
  'Turnos CARGADOS por el negocio en la ventana [p_start, p_end). Cuenta por created_at y no filtra por estado: mide uso del sistema, no actividad comercial.';
