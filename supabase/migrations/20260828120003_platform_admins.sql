-- ============================================================
-- 0019 — Super admin de plataforma.
--
-- EL PROBLEMA.
--
-- Todo el aislamiento del sistema cuelga de una sola función:
--
--   public.auth_tenant_ids() -> los tenants del usuario logueado
--
-- y las policies de las 10 tablas la usan (30 veces, en 7 migraciones).
-- Eso está bien para un negocio, pero deja al dueño de la plataforma sin
-- forma de ver nada: hoy hay que entrar a mano a Supabase.
--
-- POR QUÉ NO ALCANZA EL ROL QUE YA EXISTE.
--
-- `member_role` ya tiene un valor 'admin', pero vive en `memberships`, donde
-- `tenant_id` es NOT NULL con FK a `tenants`. Ese rol siempre significa "rol
-- de fulano DENTRO de un negocio". Un super admin no es miembro de ningún
-- negocio: es de la plataforma. Meterlo ahí obligaría a una fila por cada
-- tenant (mantenida por un trigger para siempre) o a un tenant fantasma de
-- sentinela. Las dos son mentiras en el modelo, así que el rol va en su
-- propia tabla.
--
-- POR QUÉ EL CAMBIO ENTRA ACÁ Y NO EN CADA POLICY.
--
-- Se podía sumar `or is_super_admin()` policy por policy. Son 30 lugares hoy,
-- y —lo peor— cada policy NUEVA habría que acordarse de sumarla: el olvido
-- sería silencioso y el agujero, invisible. Cambiando la función de una sola
-- vez, las 30 policies existentes lo heredan sin tocarse y las futuras
-- también, sin poder olvidarse.
--
-- EL ALCANCE ES TOTAL, Y ES A PROPÓSITO: LECTURA Y ESCRITURA.
--
-- Varias policies son `for all` (por ejemplo `services_all_members`), así que
-- el super admin también puede escribir en cualquier negocio. Es exactamente
-- el punto: el panel existe para dejar de meter mano en Supabase, y meter
-- mano incluye arreglar cosas, no sólo mirarlas.
--
-- POR QUÉ NO HAY RECURSIÓN.
--
-- `auth_tenant_ids()` pasa a leer `tenants`, que tiene una policy que llama a
-- `auth_tenant_ids()`. Parece un bucle y no lo es: la función es SECURITY
-- DEFINER y su dueño saltea RLS (no hay `force row level security` en el
-- esquema). Eso ya se venía usando: la policy `memberships_select_my_tenants`
-- llama a esta misma función, que lee `memberships`. Si el mecanismo no
-- valiera, el sistema ya estaría en recursión infinita hoy.
-- ============================================================

-- ---------- platform_admins ----------
-- Una fila por persona con acceso a toda la plataforma. Dar o sacar el
-- permiso es un INSERT/DELETE, con efecto inmediato en la próxima consulta
-- (a diferencia de un claim en el JWT, que espera al refresh del token).
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,                                -- por qué tiene el acceso
  created_at timestamptz not null default now()
);

-- RLS habilitada y CERO policies: deny por defecto. No es una omisión, es el
-- diseño. Nadie —ni siquiera un super admin— lee ni escribe esta tabla desde
-- PostgREST; se administra por SQL o con `service_role`. Si esto se abriera,
-- cualquiera podría auto-promoverse con un INSERT.
alter table public.platform_admins enable row level security;

-- Segundo cerrojo, delante del primero: sin GRANT no se llega ni a evaluar la
-- RLS. Van los dos porque Supabase aplica default privileges sobre `public` y
-- una tabla nueva puede nacer con permisos que nadie pidió.
revoke all on public.platform_admins from anon, authenticated;

-- ---------- is_super_admin() ----------
-- SECURITY DEFINER porque lee una tabla que, por lo de arriba, no puede leer
-- nadie. Devuelve boolean y no falla nunca para un usuario común: sin sesión,
-- `auth.uid()` es NULL y el EXISTS da false.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$;

-- ---------- auth_tenant_ids(), ahora con la rama del admin ----------
-- El CASE no es cosmético: garantiza que `is_super_admin()` se evalúe UNA vez
-- por llamada. Escrito como `... from tenants where is_super_admin()` la
-- función es STABLE, no IMMUTABLE, y el planner la ejecutaría por cada fila
-- de `tenants` — dentro de una policy que ya corre por fila, eso se multiplica
-- feo. El `unnest` está porque el CASE devuelve un array y el contrato de
-- salida sigue siendo `setof uuid`: las 30 policies no se enteran del cambio.
-- El `coalesce` cubre el borde del usuario sin nada: array vacío, cero filas,
-- nunca una fila NULL (que en un `id in (...)` se comporta distinto).
create or replace function public.auth_tenant_ids()
returns setof uuid
language sql
stable
security definer set search_path = public
as $$
  select unnest(
    case
      when public.is_super_admin()
        then (select coalesce(array_agg(t.id), '{}'::uuid[]) from public.tenants t)
      else (select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
            from public.memberships m
            where m.user_id = auth.uid())
    end
  );
$$;

-- Misma convención que el resto de los RPC `security definer` del repo
-- (`delete_service`, `replace_staff_schedule`, `create_public_booking`…):
-- cerrar el default de Postgres, que da EXECUTE a PUBLIC, y abrir sólo lo que
-- hace falta. `anon` queda afuera: el panel admin la va a llamar por RPC y
-- para eso hay que estar logueado. Sin esto, `is_super_admin` quedaría como
-- endpoint anónimo de PostgREST — no filtra nada (sin sesión `auth.uid()` es
-- NULL y devuelve false), pero es superficie que nadie pidió.
--
-- Ojo con lo que NO se toca: `auth_tenant_ids()` conserva su EXECUTE para
-- PUBLIC. Las expresiones de una policy se evalúan con los privilegios del rol
-- que consulta, así que revocárselo a `anon` rompería las policies de las
-- pantallas públicas. Y `is_super_admin()` no necesita grant para que las
-- policies anden: lo llama `auth_tenant_ids()`, que es SECURITY DEFINER y
-- corre como su dueño.
revoke execute on function public.is_super_admin() from public, anon;
grant  execute on function public.is_super_admin() to authenticated;
