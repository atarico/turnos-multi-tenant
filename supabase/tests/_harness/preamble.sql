-- ============================================================
-- Supabase harness preamble
--
-- Loaded into a fresh, disposable Postgres BEFORE the migrations run. It
-- stubs the pieces a real Supabase project provides for free (the Data API
-- roles, a minimal `auth` schema, a minimal `storage` schema, and the
-- default privileges Supabase applies on `public`), so migrations and SQL
-- tests see the same objects they'd see against a real project.
--
-- What this deliberately does NOT do: give `auth.users.id` a default value.
-- Real GoTrue assigns the id; a default here would hide bugs like the ones
-- fixed in PR #74 (seeds that inserted a user without an id, silently
-- borrowing someone else's from the harness). Every seed in
-- supabase/tests/*.sql passes `id` explicitly, and this preamble must keep
-- rejecting the ones that don't.
--
-- Scope: only what supabase/migrations/*.sql and supabase/tests/*.sql
-- actually reference. No extra convenience Supabase itself lacks.
-- ============================================================

\set ON_ERROR_STOP on

-- ------------------------------------------------------------
-- Data API roles
--
-- Cluster-wide, not per-database: dropping and recreating the test database
-- does NOT remove them, so a second run against the same Postgres server
-- must find them already there. Guard every CREATE ROLE or it fails with
-- "role already exists" on the second run.
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit;
  end if;
end
$$;

-- Real Supabase's service_role bypasses RLS entirely (it's how, e.g., a
-- reminder job reads bookings across every tenant). ALTER ROLE is idempotent,
-- so it's safe to re-assert this even when the role already existed from a
-- previous run.
alter role service_role bypassrls;

-- ------------------------------------------------------------
-- auth schema
-- ------------------------------------------------------------
create schema if not exists auth;

grant usage on schema auth to anon, authenticated, service_role;

-- Honest shape: `id` has NO default. GoTrue assigns it in real Supabase;
-- defaulting it here would silently paper over the exact bug PR #74 fixed.
create table if not exists auth.users (
  id uuid not null primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- PostgREST puts the current request's JWT claims into GUCs. The SQL tests
-- (see `rg -n "request.jwt" supabase/tests`) set `request.jwt.claim.sub` and
-- then `set local role authenticated`, exactly the way a real PostgREST
-- request would look from inside Postgres. auth.uid() reads that GUC back.
-- The `request.jwt.claims` fallback covers the newer single-JSON-GUC
-- PostgREST convention, in case anything ever switches to it.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    jsonb_build_object(
      'sub', nullif(current_setting('request.jwt.claim.sub', true), '')
    )
  )
$$;

-- ------------------------------------------------------------
-- storage schema
--
-- Only what supabase/migrations/20260816120001_tenant_logos_bucket.sql
-- references: the buckets/objects tables it inserts into and writes policies
-- against, and storage.foldername(), which those policies call.
-- ------------------------------------------------------------
create schema if not exists storage;

grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text not null primary key,
  name               text not null,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid not null primary key,
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Real Supabase has RLS enabled on storage.objects by default; the bucket
-- migration only adds policies, it never enables RLS itself.
alter table storage.objects enable row level security;

-- Same definition the storage extension ships: split the object path on
-- `/` and drop the last segment (the file name), leaving the folder path.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

-- ------------------------------------------------------------
-- Default privileges
--
-- Supabase applies these on every project before any migration runs. A bare
-- disposable Postgres does not, and supabase/tests/platform_admins.sql calls
-- that out explicitly ("el Postgres descartable no trae los default
-- privileges que Supabase ya aplicó") to justify grants some test blocks add
-- by hand. Applying the real default here first is what makes those
-- explicit grants land as harmless no-ops instead of load-bearing
-- workarounds, and matches what migrations that DO care (platform_admins,
-- coupons) explicitly `revoke` right back.
--
-- Must run BEFORE the migrations: ALTER DEFAULT PRIVILEGES only affects
-- objects created AFTER it, by the same role that ran it.
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
