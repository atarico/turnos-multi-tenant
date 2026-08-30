-- ============================================================
-- Cortesía: un plan regalado por un operador, que sobrevive al webhook.
--
-- ## Por qué no alcanza con pisar `tenants.plan`
--
-- Esa columna es del webhook. `apply_subscription_payment` la escribe en cada
-- aviso `active` con el plan pactado en el preapproval, y la baja a 'basico' al
-- cancelar. Un regalo escrito ahí dura hasta la próxima renovación y después
-- desaparece SIN DEJAR RASTRO: nadie puede saber después que existió, ni por
-- qué, ni quién lo dio.
--
-- Así que la cortesía es un hecho aparte. `tenants.plan` sigue significando
-- honestamente "lo que este negocio paga" —que es lo que hace que la
-- comparación contra la suscripción, en el panel de plataforma, siga queriendo
-- decir algo— y el plan efectivo se resuelve al leer. Ver `effectivePlan` en
-- `src/modules/billing/domain/courtesy.ts`.
--
-- ## Por qué el vencimiento se evalúa al leer y no con una tarea
--
-- En este proyecto no corre nada agendado. Una cortesía que dependiera de un
-- job para apagarse sería una cortesía para siempre el día que el job no corra,
-- y nadie se enteraría. Resuelta al leer, caduca sola y sin infraestructura.
--
-- ## Quién puede otorgarla
--
-- Sólo un super admin, y sólo a través de estas dos funciones. El UPDATE
-- directo sobre las columnas nuevas es imposible desde una sesión: la
-- migración anterior revocó el update sobre `tenants` y lo devolvió únicamente
-- sobre (brand_color, logo_url), así que TODA columna que se agregue de acá en
-- adelante nace cerrada. Esa es la propiedad que se compró allá y se cobra acá.
-- ============================================================

alter table public.tenants
  add column plan_courtesy            public.plan_tier,
  -- `null` con cortesía puesta significa "hasta que la saquen". Es un estado
  -- válido y frecuente: un trato sin fecha de fin.
  add column plan_courtesy_until      timestamptz,
  add column plan_courtesy_reason     text,
  add column plan_courtesy_granted_by uuid references auth.users(id) on delete set null,
  add column plan_courtesy_granted_at timestamptz;

-- Un regalo a medias no sirve para nada: sin motivo no se puede auditar, y sin
-- fecha de otorgamiento no se puede reconstruir qué pasó. O está el hecho
-- completo o no hay hecho. Mismo criterio que `subscriptions_fx_complete`.
--
-- `plan_courtesy_until` y `granted_by` quedan libres a propósito: el primero
-- porque "sin vencimiento" es legítimo, el segundo porque una cuenta borrada
-- pone su referencia en null y eso no puede invalidar la fila.
alter table public.tenants
  add constraint tenants_plan_courtesy_complete check (
    (plan_courtesy is null
      and plan_courtesy_until is null
      and plan_courtesy_reason is null
      and plan_courtesy_granted_at is null)
    or (plan_courtesy is not null
      and plan_courtesy_reason is not null
      and plan_courtesy_granted_at is not null)
  );

comment on column public.tenants.plan_courtesy is
  'Plan regalado por un operador de plataforma. El plan EFECTIVO es el mejor '
  'entre este y `plan`, si la cortesía no venció. Ver effectivePlan().';


-- ------------------------------------------------------------
-- Otorgar
-- ------------------------------------------------------------
create or replace function public.grant_plan_courtesy(
  p_tenant_id uuid,
  p_plan      public.plan_tier,
  p_reason    text,
  p_until     timestamptz default null,
  p_now       timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- La reja va ADENTRO y no en un `grant` a un rol, porque `security definer`
  -- corre con los privilegios del dueño: sin este chequeo, cualquier usuario
  -- logueado que adivine el nombre de la función se regala lo que quiera.
  if not public.is_super_admin() then
    raise exception 'solo un operador de plataforma puede otorgar una cortesia'
      using errcode = 'insufficient_privilege';
  end if;

  -- Un motivo en blanco es lo mismo que no tener motivo, y el motivo es la
  -- mitad del valor de este registro: dentro de seis meses, "premium" sin un
  -- porqué es indistinguible de un error.
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'la cortesia necesita un motivo'
      using errcode = 'check_violation';
  end if;

  -- Una fecha ya vencida crearía una cortesía muerta al nacer: la fila diría
  -- que hay un regalo y `effectivePlan` lo ignoraría. Un estado que se ve de
  -- una forma y se comporta de otra es peor que un error.
  if p_until is not null and p_until <= p_now then
    raise exception 'el vencimiento de la cortesia tiene que ser futuro'
      using errcode = 'check_violation';
  end if;

  update public.tenants
     set plan_courtesy            = p_plan,
         plan_courtesy_until      = p_until,
         plan_courtesy_reason     = btrim(p_reason),
         plan_courtesy_granted_by = v_actor,
         plan_courtesy_granted_at = p_now
   where id = p_tenant_id;

  if not found then
    raise exception 'no existe el negocio %', p_tenant_id
      using errcode = 'no_data_found';
  end if;
end;
$$;

comment on function public.grant_plan_courtesy(
  uuid, public.plan_tier, text, timestamptz, timestamptz
) is
  'Otorga un plan de cortesía a un negocio. Sólo un super admin. El plan '
  'efectivo es el MEJOR entre la cortesía y el plan pagado: un regalo nunca '
  'empeora lo comprado.';


-- ------------------------------------------------------------
-- Quitar
-- ------------------------------------------------------------
create or replace function public.revoke_plan_courtesy(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'solo un operador de plataforma puede quitar una cortesia'
      using errcode = 'insufficient_privilege';
  end if;

  -- Las cinco columnas se limpian juntas: el CHECK exige el hecho completo o
  -- nada, así que dejar una sola colgada rechazaría la fila entera.
  update public.tenants
     set plan_courtesy            = null,
         plan_courtesy_until      = null,
         plan_courtesy_reason     = null,
         plan_courtesy_granted_by = null,
         plan_courtesy_granted_at = null
   where id = p_tenant_id;

  if not found then
    raise exception 'no existe el negocio %', p_tenant_id
      using errcode = 'no_data_found';
  end if;
end;
$$;


-- El operador llama a las dos con SU sesión, no con la service key: quién la
-- otorgó sale de `auth.uid()`, y con la service key no hay nadie a quien
-- anotar. Por eso el execute va a `authenticated` y la autorización real la
-- hace `is_super_admin()` adentro.
revoke execute on function public.grant_plan_courtesy(
  uuid, public.plan_tier, text, timestamptz, timestamptz
) from public, anon;
revoke execute on function public.revoke_plan_courtesy(uuid) from public, anon;

grant execute on function public.grant_plan_courtesy(
  uuid, public.plan_tier, text, timestamptz, timestamptz
) to authenticated;
grant execute on function public.revoke_plan_courtesy(uuid) to authenticated;
