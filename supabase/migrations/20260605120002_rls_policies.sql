-- ============================================================
-- 0002 — Row Level Security
-- Aislamiento por tenant: cada negocio accede SOLO a sus datos.
-- El filtro vive en la base de datos, no en el código de la app.
-- ============================================================

alter table public.tenants     enable row level security;
alter table public.profiles    enable row level security;
alter table public.memberships enable row level security;
alter table public.services    enable row level security;

-- ---------- tenants ----------
-- Los miembros ven y editan su negocio. El INSERT NO se habilita acá: pasa
-- siempre por create_business() (SECURITY DEFINER), así nadie crea un tenant
-- "suelto" sin membresía de dueño.
create policy "tenants_select_members"
  on public.tenants for select
  using (id in (select public.auth_tenant_ids()));

create policy "tenants_update_members"
  on public.tenants for update
  using (id in (select public.auth_tenant_ids()))
  with check (id in (select public.auth_tenant_ids()));

-- ---------- profiles ----------
-- Cada usuario solo su propio perfil.
create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- memberships ----------
-- Ves las membresías de los negocios a los que pertenecés (para listar el equipo).
create policy "memberships_select_my_tenants"
  on public.memberships for select
  using (tenant_id in (select public.auth_tenant_ids()));

-- ---------- services ----------
-- El negocio gestiona (CRUD completo) sus propios servicios y nada más.
create policy "services_all_members"
  on public.services for all
  using (tenant_id in (select public.auth_tenant_ids()))
  with check (tenant_id in (select public.auth_tenant_ids()));

-- NOTA: la lectura PÚBLICA del branding de un negocio (página de reservas en
-- /[slug], sin login) se resuelve en la Fase 2 con una vista de columnas
-- públicas. No abrimos select anónimo sobre la tabla base para no filtrar
-- plan, país ni otros datos internos.
