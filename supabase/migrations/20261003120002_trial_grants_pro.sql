-- ------------------------------------------------------------
-- Una prueba gratis VIVA da Pro
--
-- Decisión de producto: la prueba tiene que mostrar el producto, así que
-- mientras dura, el plan efectivo es al menos Pro. Es lo mismo que hace
-- `effectivePlan` en TypeScript (`billing/domain/courtesy.ts`) con
-- `TRIAL_PLAN`; el literal 'pro' de acá es su ESPEJO: cambian juntos, con una
-- migración nueva que redefina esta función.
--
-- `tenants.plan` NO se toca: sigue siendo lo que el negocio paga. Se resuelve
-- al LEER, igual que la cortesía, así la prueba caduca sola.
--
-- "Viva" = misma regla que `isInTrial`: estado 'trialing' Y `trial_ends_at`
-- en el futuro. Vencida y sin pago, no aporta nada: el negocio queda con lo
-- que paga (y sin turnos nuevos hasta pagar algún plan, como hoy).
--
-- `greatest()` alcanza porque el enum está ordenado basico < pro < premium, y
-- una prueba nunca empeora lo pagado ni una cortesía mayor. Los grants se
-- reafirman: `create or replace` los conserva, pero esta función decide cobros
-- y no debe depender de eso.
-- ------------------------------------------------------------
create or replace function public.tenant_effective_plan(p_tenant_id uuid)
returns public.plan_tier
language sql
stable
security definer set search_path = public
as $$
  select greatest(
    case
      when t.plan_courtesy is null then t.plan
      when t.plan_courtesy_until is not null
           and t.plan_courtesy_until <= now() then t.plan
      else greatest(t.plan, t.plan_courtesy)
    end,
    case
      -- 'pro' espeja `TRIAL_PLAN` (src/modules/billing/domain/plan.ts).
      when exists (
        select 1 from public.subscriptions s
        where s.tenant_id = t.id
          and s.status = 'trialing'
          and s.trial_ends_at > now()
      ) then 'pro'::public.plan_tier
      else 'basico'::public.plan_tier
    end
  )
  from public.tenants t
  where t.id = p_tenant_id;
$$;

revoke execute on function public.tenant_effective_plan(uuid)
  from public, anon, authenticated;
grant execute on function public.tenant_effective_plan(uuid) to service_role;
