-- ============================================================
-- El operador ve la LISTA de negocios, no el adentro de ninguno.
--
-- Cierra el issue #50. Hasta hoy el super admin de plataforma tenía lectura Y
-- ESCRITURA sobre cada fila de cada negocio: turnos, personal, disponibilidad,
-- servicios y logos. No lo garantizaba nada más que la ausencia de una
-- pantalla — un `fetch` a PostgREST desde la consola del browser llegaba a
-- todo eso.
--
-- LO QUE 20260828120003 HIZO BIEN, Y NO SE DESHACE: meter el poder DENTRO de
-- `auth_tenant_ids()` en vez de sumar `or is_super_admin()` a 30 policies. El
-- razonamiento de aquella migración sigue en pie para lo que estaba
-- resolviendo — 30 lugares para olvidarse, y uno más por cada tabla nueva.
--
-- LO QUE SE INVIERTE ES LA DIRECCIÓN DEL OLVIDO, y es todo el cambio.
--
-- Con el poder adentro de la función, el default de cada policy nueva es
-- "el operador entra", y olvidarse es SILENCIOSO: la tabla nueva queda abierta
-- y nada lo dice. Con el poder afuera, el default es "el operador no entra", y
-- olvidarse es RUIDOSO: la pantalla del panel se rompe y alguien lo ve el
-- mismo día. Para una reja de seguridad, el olvido tiene que romper lo que
-- funciona, nunca abrir lo que estaba cerrado.
--
-- POR QUÉ EL COSTO ES CASI CERO, que es lo que hace posible el cambio: el
-- panel de admin lee exactamente DOS tablas —`tenants` y `subscriptions`— y no
-- escribe ninguna. Todo lo que el operador ESCRIBE ya pasa por funciones
-- `security definer` que hacen `is_super_admin()` adentro:
--
--   grant_plan_courtesy / revoke_plan_courtesy   (20260830120002)
--   create_coupon / set_coupon_active            (20260831120001)
--
-- O sea que la escritura ancha que esta migración saca no la usaba nadie. Lo
-- que se pierde es la capacidad de "meter mano" a mano desde el panel, que era
-- el argumento de 20260828120003 y que en la práctica nunca se construyó: cada
-- cosa que el operador hace de verdad tiene su función, con su chequeo y su
-- registro.
--
-- LO QUE EL OPERADOR PIERDE, dicho sin vueltas: leer y escribir `bookings`,
-- `staff`, `staff_services`, `staff_availability`, `services` y el bucket de
-- logos de cualquier negocio. Si mañana el panel necesita alguna de esas, se
-- agrega la policy correspondiente y queda escrito en una migración — que es
-- justamente la propiedad que se está comprando.
-- ============================================================

-- ------------------------------------------------------------
-- `auth_tenant_ids()` vuelve a significar UNA sola cosa.
--
-- "Los negocios de los que este usuario es miembro". Sin ramas, sin excepción
-- de plataforma. Las 30 policies que la llaman recuperan su lectura literal, y
-- el que lea cualquiera de ellas ve lo que hace sin tener que saber que una
-- función tres archivos más allá le agregaba un caso.
--
-- El `coalesce` y el `unnest` se conservan por lo mismo que estaban: el
-- contrato de salida es `setof uuid`, y un usuario sin nada tiene que dar cero
-- filas y no una fila NULL, que en un `id in (...)` se comporta distinto.
--
-- `is_super_admin()` NO se toca ni se borra: sigue siendo la que usan las dos
-- policies de abajo y las cuatro funciones de escritura del operador.
-- ------------------------------------------------------------
create or replace function public.auth_tenant_ids()
returns setof uuid
language sql
stable
security definer set search_path = public
as $$
  select unnest(
    (select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
       from public.memberships m
      where m.user_id = auth.uid())
  );
$$;

comment on function public.auth_tenant_ids() is
  'Los negocios de los que el usuario logueado es MIEMBRO, y nada más. El '
  'super admin de plataforma no pasa por acá: su alcance está declarado, '
  'policy por policy, en las que lo necesitan. Ver 20260908120001.';

-- ------------------------------------------------------------
-- La lista de negocios: lo único que el panel necesita ver.
--
-- `or public.is_super_admin()` va DESPUÉS del `in (...)` a propósito: para un
-- usuario común la primera condición decide y la función del admin ni se
-- evalúa, que es el camino que corre en cada request de cada negocio.
--
-- Es `for select`. La policy de UPDATE de `tenants` NO recibe la rama: lo
-- único que el operador cambia de un negocio es el plan de cortesía, y eso
-- pasa por `grant_plan_courtesy()`, que ya chequea `is_super_admin()` adentro
-- y deja escrito quién y por qué. Un UPDATE ancho al lado de esa función sería
-- una segunda puerta al mismo cuarto, sin el registro.
-- ------------------------------------------------------------
drop policy if exists "tenants_select_members" on public.tenants;
create policy "tenants_select_members"
  on public.tenants for select
  using (
    id in (select public.auth_tenant_ids())
    or public.is_super_admin()
  );

-- ------------------------------------------------------------
-- Y la suscripción de cada uno, que es la otra mitad del panel.
--
-- Es lo que contesta las preguntas por las que el panel existe: quién está en
-- prueba, a quién le falló el cobro, quién se dio de baja. Sólo lectura: el
-- operador no mueve una suscripción a mano, y si alguna vez hiciera falta va a
-- ser con una función que registre el movimiento, no con un UPDATE suelto.
-- ------------------------------------------------------------
drop policy if exists "subscriptions_select_members" on public.subscriptions;
create policy "subscriptions_select_members"
  on public.subscriptions for select
  using (
    tenant_id in (select public.auth_tenant_ids())
    or public.is_super_admin()
  );
