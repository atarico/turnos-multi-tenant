-- ============================================================
-- 0001 — Esquema base multi-tenant
-- Negocios (tenants), perfiles, membresías y servicios.
-- ============================================================

-- gen_random_uuid() vive en pgcrypto. Supabase ya lo trae, pero lo dejamos
-- explícito para que la migración sea reproducible en cualquier Postgres.
create extension if not exists pgcrypto;

-- ---------- Tipos ----------
create type public.plan_tier as enum ('basico', 'pro', 'premium');
create type public.member_role as enum ('owner', 'admin', 'staff');

-- ---------- updated_at automático ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- tenants (negocios) ----------
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,            -- identifica la URL pública: /[slug]
  name        text not null,
  country     text not null,                   -- ISO-3166 alpha-2 ('AR','US'...) → define la pasarela de pago
  timezone    text not null default 'America/Argentina/Buenos_Aires',
  plan        public.plan_tier not null default 'basico',
  logo_url    text,
  brand_color text not null default '#6366f1', -- personalización de marca
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- slug válido para URL: minúsculas, números y guiones (sin guiones al borde)
  constraint tenants_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- ---------- profiles (extiende auth.users) ----------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Crear el profile automáticamente cuando se registra un usuario en auth.users.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- memberships (user ↔ tenant, con rol) ----------
create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       public.member_role not null default 'owner',
  created_at timestamptz not null default now(),
  unique (user_id, tenant_id)              -- un usuario, una membresía por negocio
);

create index memberships_user_id_idx   on public.memberships(user_id);
create index memberships_tenant_id_idx on public.memberships(tenant_id);

-- ---------- services (servicios que ofrece el negocio) ----------
create table public.services (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  description  text,
  duration_min int  not null check (duration_min > 0),
  price_cents  int  not null default 0 check (price_cents >= 0),  -- centavos, NUNCA float para dinero
  currency     text not null default 'ARS',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index services_tenant_id_idx on public.services(tenant_id);

create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

-- ---------- Helper: tenants del usuario autenticado ----------
-- SECURITY DEFINER para leer memberships SIN disparar su RLS de forma recursiva.
-- Esta función es la base de todas las policies de aislamiento por tenant.
create or replace function public.auth_tenant_ids()
returns setof uuid
language sql
stable
security definer set search_path = public
as $$
  select tenant_id from public.memberships where user_id = auth.uid();
$$;

-- ---------- Registro atómico de un negocio ----------
-- Crea el tenant y la membresía 'owner' en UNA transacción. Si algo falla,
-- no queda un negocio sin dueño ni un dueño sin negocio. La llama el signup,
-- ya con el usuario autenticado.
create or replace function public.create_business(
  p_name     text,
  p_slug     text,
  p_country  text,
  p_timezone text default 'America/Argentina/Buenos_Aires'
)
returns public.tenants
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant public.tenants;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  insert into public.tenants (name, slug, country, timezone)
  values (p_name, p_slug, p_country, coalesce(p_timezone, 'America/Argentina/Buenos_Aires'))
  returning * into v_tenant;

  insert into public.memberships (user_id, tenant_id, role)
  values (auth.uid(), v_tenant.id, 'owner');

  return v_tenant;
end;
$$;
