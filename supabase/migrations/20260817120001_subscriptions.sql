-- ============================================================
-- 0013 — Suscripciones y consumo por período
--
-- Dos tablas con roles distintos que conviene no confundir:
--   · subscriptions — la HISTORIA DE COBRO. Qué plan se está pagando,
--     en qué estado está, qué período cubre y cuánto se cobró.
--   · usage_periods — el CONSUMO de ese período. Los contadores que se
--     resetean con cada cobro.
--
-- El plan EFECTIVO sigue viviendo en `tenants.plan`: es un derecho que se
-- pregunta en cada request y tiene que leerse sin un join. La suscripción
-- es lo que lo MUEVE cuando pasa algo de cobro. Denormalización a
-- propósito, no descuido.
--
-- Nadie del negocio escribe estas tablas. Ver la sección de RLS al final.
-- ============================================================

-- ---------- Tipos ----------
-- `past_due` es su propio estado y no un `active` con una bandera: el cobro
-- falló pero el servicio sigue andando durante la gracia. Colapsarlo contra
-- `active` haría imposible saber a quién hay que avisarle.
create type public.subscription_status as enum (
  'trialing',   -- prueba gratis, todavía sin cobro
  'active',     -- último cobro OK
  'past_due',   -- falló el cobro, corriendo el período de gracia
  'canceled'    -- dada de baja, no se vuelve a cobrar
);

-- ---------- subscriptions ----------
create table public.subscriptions (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  plan      public.plan_tier not null,
  status    public.subscription_status not null default 'trialing',

  -- El período es la unidad de todo: define desde cuándo rige el plan y
  -- cuándo se resetean los contadores de consumo.
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null,
  trial_ends_at        timestamptz,

  -- Precio en USD como fuente de verdad; el monto en moneda local es lo que
  -- REALMENTE se cobró. Dos campos distintos a propósito: Mercado Pago cobra
  -- en ARS y el dólar se mueve, así que sin guardar la cotización usada no hay
  -- forma de explicar después por qué cada cliente paga lo que paga.
  -- Centavos en enteros, NUNCA float para dinero.
  price_usd_cents      int not null check (price_usd_cents >= 0),
  charged_amount_cents int check (charged_amount_cents >= 0),
  charged_currency     text not null default 'ARS',
  fx_rate              numeric(18, 6) check (fx_rate > 0),
  fx_source            text,
  fx_quoted_at         timestamptz,

  -- Null hasta que exista la integración con la pasarela. Se deja el hueco
  -- ahora para no migrar datos después.
  provider                 text,
  provider_subscription_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint subscriptions_period_order
    check (current_period_end > current_period_start),

  -- Una cotización a medias no sirve para nada: o están los tres datos o no
  -- está ninguno. Sin esto entra una tasa sin fecha y no se puede auditar.
  constraint subscriptions_fx_complete check (
    (fx_rate is null and fx_source is null and fx_quoted_at is null)
    or (fx_rate is not null and fx_source is not null and fx_quoted_at is not null)
  ),

  -- Redundante con la primary key mirado de cerca, y necesario mirado de
  -- lejos: `usage_periods` referencia el PAR (id, tenant_id), y Postgres sólo
  -- deja referenciar columnas con un índice único encima. Sin esto, la FK
  -- compuesta de abajo no se puede declarar.
  constraint subscriptions_id_tenant_key unique (id, tenant_id)
);

create index subscriptions_tenant_id_idx on public.subscriptions(tenant_id);

-- UN negocio, UNA suscripción viva. Índice único parcial en vez de constraint
-- porque las canceladas son historia y tienen que poder acumularse: un negocio
-- que se da de baja y vuelve deja dos filas, y sólo una está viva.
create unique index subscriptions_one_live_per_tenant
  on public.subscriptions(tenant_id)
  where status in ('trialing', 'active', 'past_due');

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------- usage_periods ----------
-- Un contador por suscripción y por período.
--
-- Sólo lleva los mensajes de WhatsApp porque son lo único que no se puede
-- contar de otra tabla: no existe registro de mensajes. Los turnos NO se
-- cuentan acá — se cuentan de `bookings`, que ya es la verdad. Un contador
-- duplicado es un contador que se desincroniza.
create table public.usage_periods (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null,
  -- Denormalizado desde la suscripción para que la policy de RLS filtre sin
  -- join. Ver `security-rls-performance`: la policy corre por fila.
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  period_start timestamptz not null,
  period_end   timestamptz not null,

  whatsapp_messages_used int not null default 0
    check (whatsapp_messages_used >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint usage_periods_order check (period_end > period_start),
  -- Idempotencia: el webhook de la pasarela puede llegar dos veces por el
  -- mismo cobro, y el segundo intento tiene que chocar en vez de abrir un
  -- período duplicado que resetearía el consumo a mitad de mes.
  unique (subscription_id, period_start),

  -- EL CONSTRAINT QUE SOSTIENE EL AISLAMIENTO.
  --
  -- `tenant_id` está denormalizado y es lo ÚNICO que mira la policy de RLS de
  -- abajo. Con dos foreign keys sueltas —una a `subscriptions`, otra a
  -- `tenants`— nada impedía que apuntaran a negocios distintos: una fila del
  -- negocio A con `tenant_id` del negocio B pasaba todos los chequeos y
  -- quedaba legible por B.
  --
  -- Referenciando el PAR, el desalineo se vuelve imposible en la base en vez
  -- de depender de que cada escritor se porte bien. El precio de denormalizar
  -- se paga acá.
  constraint usage_periods_subscription_fkey
    foreign key (subscription_id, tenant_id)
    references public.subscriptions(id, tenant_id) on delete cascade
);

create index usage_periods_subscription_idx on public.usage_periods(subscription_id);
create index usage_periods_tenant_id_idx    on public.usage_periods(tenant_id);

create trigger usage_periods_set_updated_at
  before update on public.usage_periods
  for each row execute function public.set_updated_at();

-- ---------- RLS ----------
-- El negocio LEE su suscripción y su consumo, y NO escribe ninguna de las dos.
--
-- No hay policy de insert/update/delete, y eso es la decisión, no un olvido:
-- sin ella nadie con rol `authenticated` puede tocar estas filas. Si el
-- negocio pudiera actualizar su propia suscripción, se pondría `premium`
-- solo. Todo lo que escribe acá pasa por el servidor con `service_role`, que
-- es lo único que puede saltear RLS, o por funciones SECURITY DEFINER que
-- llegan con la integración de la pasarela.
alter table public.subscriptions enable row level security;
alter table public.usage_periods enable row level security;

create policy "subscriptions_select_members"
  on public.subscriptions for select
  using (tenant_id in (select public.auth_tenant_ids()));

create policy "usage_periods_select_members"
  on public.usage_periods for select
  using (tenant_id in (select public.auth_tenant_ids()));
