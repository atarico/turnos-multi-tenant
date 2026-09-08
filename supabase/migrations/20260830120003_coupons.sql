-- ============================================================
-- Cupones de descuento permanente.
--
-- ## Qué puede y qué no puede hacer un cupón acá
--
-- Mercado Pago cobra EL MISMO MONTO todos los meses en un preapproval: no
-- existe "primer mes con descuento" como parámetro. Así que un cupón de esta
-- migración fija un precio rebajado que rige mientras dure la suscripción, y se
-- aplica ANTES de abrir el preapproval. El descuento por tiempo limitado exige
-- modificar o recrear el preapproval en pleno vuelo, con sus propios modos de
-- falla, y es una tajada aparte.
--
-- ## Por qué el cupón se CONGELA en la fila de identidad
--
-- El cobro del mes que viene corresponde a lo pactado en ESE preapproval, no a
-- lo que diga el cupón hoy. Si el descuento se leyera de `coupons` en cada
-- renovación, desactivar un cupón le subiría el precio a todos los que ya lo
-- habían usado —sin avisarles y sin que nadie lo decidiera—. Es el mismo
-- razonamiento que llevó el plan a `subscription_provider_refs` cuando se cerró
-- el hueco del preapproval huérfano.
--
-- El monto ya rebajado vive en `charged_amount_cents`, que es lo que realmente
-- se cobra. El cupón y su descuento se guardan al lado para poder EXPLICAR ese
-- número seis meses después, que es cuando alguien pregunta por qué este
-- cliente paga distinto.
-- ============================================================

create table public.coupons (
  -- El código ES la clave. Se guarda normalizado en mayúsculas y sin espacios
  -- para que "beta10", " BETA10 " y "BETA10" sean el mismo cupón: quien lo
  -- tipea lo hace desde un mail o un papel, y la diferencia de mayúsculas no
  -- es una decisión de nadie.
  code text primary key
    constraint coupons_code_normalized check (code = upper(btrim(code)))
    constraint coupons_code_format check (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),

  -- Puntos básicos, no porcentaje: 9900 = 99%. Toda la plata de este proyecto
  -- viaja en enteros y los descuentos no son la excepción — un 99,5% con float
  -- es la clase de redondeo que aparece como un peso de diferencia en el
  -- resumen de la tarjeta.
  --
  -- El techo es 9900 y NO 10000 a propósito: un 100% deja el preapproval en
  -- cero y Mercado Pago lo rechaza. Un cupón que no se puede usar es peor que
  -- uno que no existe, porque falla recién en el checkout y de cara al cliente.
  discount_bps int not null
    constraint coupons_discount_range check (discount_bps between 1 and 9900),

  -- Apagarlo es distinto de borrarlo: las suscripciones que ya lo usaron
  -- guardan su propia copia del descuento, así que apagar no le sube el precio
  -- a nadie. Borrar la fila perdería el `note` que explica para qué se creó.
  active boolean not null default true,

  expires_at timestamptz,

  -- `null` = sin tope. El conteo se incrementa al ATARLO a un preapproval, no
  -- cuando el cobro entra: en ese momento el descuento ya quedó comprometido en
  -- algo que va a cobrar. Un checkout abandonado quema un canje, y esa es la
  -- dirección conservadora — canjear de menos cuesta una venta, canjear de más
  -- cuesta plata todos los meses.
  max_redemptions int
    constraint coupons_max_redemptions_positive check (max_redemptions > 0),
  redemptions int not null default 0
    constraint coupons_redemptions_not_negative check (redemptions >= 0),

  note       text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Deny-all, igual que `platform_admins`: un cupón legible desde el cliente es
-- una lista de códigos de descuento publicada. El canje pasa por una función
-- security definer que devuelve el descuento, nunca la tabla.
alter table public.coupons enable row level security;
revoke all on public.coupons from anon, authenticated;

comment on table public.coupons is
  'Cupones de descuento permanente. No son legibles desde una sesión: el canje '
  'va por redeem_coupon(). Ver 20260830120003_coupons.sql.';


-- El cupón pactado en ESTE preapproval, congelado junto al plan.
alter table public.subscription_provider_refs
  add column coupon_code   text,
  add column discount_bps  int;

-- O están los dos o no está ninguno: un descuento sin código no se puede
-- explicar, y un código sin descuento no explica el monto.
alter table public.subscription_provider_refs
  add constraint provider_refs_coupon_complete check (
    (coupon_code is null and discount_bps is null)
    or (coupon_code is not null and discount_bps is not null)
  );


-- ------------------------------------------------------------
-- Canjear
-- ------------------------------------------------------------
--
-- Valida y reserva EN UNA SOLA sentencia. Separar el `select` del `update`
-- dejaría una ventana entre "está disponible" y "lo tomé": dos checkouts
-- simultáneos leerían el mismo `redemptions` y los dos pasarían el tope. El
-- `update ... where` hace que la condición y la reserva las evalúe Postgres
-- sobre la misma fila bloqueada.
create or replace function public.redeem_coupon(
  p_code text,
  p_now  timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code     text := upper(btrim(coalesce(p_code, '')));
  v_discount int;
begin
  if v_code = '' then
    return null;
  end if;

  update public.coupons
     set redemptions = redemptions + 1
   where code = v_code
     and active
     and (expires_at is null or expires_at > p_now)
     and (max_redemptions is null or redemptions < max_redemptions)
  returning discount_bps into v_discount;

  -- `null` cubre los cuatro motivos —no existe, apagado, vencido, agotado— y es
  -- deliberado: distinguirlos de cara al cliente convierte el campo en un
  -- oráculo para adivinar códigos ajenos. Quien lo tipeó mal necesita saber que
  -- no sirve, no por qué.
  return v_discount;
end;
$$;

comment on function public.redeem_coupon(text, timestamptz) is
  'Valida y reserva un cupón en una sola sentencia. Devuelve el descuento en '
  'puntos básicos, o null si el código no sirve por cualquier motivo.';

-- Sólo el backend. El canje ocurre dentro de `startCheckout`, que ya usa la
-- service key para estampar: dejárselo a una sesión permitiría contar canjes
-- sin llegar nunca a abrir un preapproval, y con eso agotar un cupón ajeno.
revoke execute on function public.redeem_coupon(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.redeem_coupon(text, timestamptz) to service_role;


-- ------------------------------------------------------------
-- attach_subscription_checkout, ahora con el cupón
-- ------------------------------------------------------------
--
-- La firma vieja se DROPEA explícitamente. Un `create or replace` con otra
-- lista de parámetros deja las DOS funciones vivas, y `service_role` podría
-- seguir llamando a la que no guarda el cupón: el descuento se aplicaría en el
-- preapproval y no quedaría registrado en ningún lado. Es el mismo cuidado que
-- hubo al cambiar `apply_subscription_payment`.
drop function if exists public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text, text
);

create or replace function public.attach_subscription_checkout(
  p_tenant_id                uuid,
  p_subscription_id          uuid,
  p_plan                     public.plan_tier,
  p_price_usd_cents          int,
  p_charged_amount_cents     int,
  p_fx_rate                  numeric,
  p_fx_source                text,
  p_fx_quoted_at             timestamptz,
  p_provider                 text,
  p_provider_subscription_id text,
  p_coupon_code              text default null,
  p_discount_bps             int  default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.subscriptions
     set plan                     = p_plan,
         price_usd_cents          = p_price_usd_cents,
         charged_amount_cents     = p_charged_amount_cents,
         fx_rate                  = p_fx_rate,
         fx_source                = p_fx_source,
         fx_quoted_at             = p_fx_quoted_at,
         provider                 = p_provider,
         provider_subscription_id = p_provider_subscription_id,
         updated_at               = now()
   where id        = p_subscription_id
     and tenant_id = p_tenant_id
     and status   <> 'canceled';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  insert into public.subscription_provider_refs (
    provider, provider_subscription_id, subscription_id, tenant_id,
    plan, charged_amount_cents, coupon_code, discount_bps
  )
  values (
    p_provider, p_provider_subscription_id, p_subscription_id, p_tenant_id,
    p_plan, p_charged_amount_cents, p_coupon_code, p_discount_bps
  )
  on conflict (provider, provider_subscription_id) do nothing;

  return true;
end;
$$;

revoke execute on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text,
  text, text, int
) from public, anon, authenticated;
grant execute on function public.attach_subscription_checkout(
  uuid, uuid, public.plan_tier, int, int, numeric, text, timestamptz, text,
  text, text, int
) to service_role;
