-- ============================================================
-- El plan de un negocio deja de ser escribible desde una sesión.
--
-- ## El agujero
--
-- `tenants_update_members` decide QUÉ FILAS puede tocar un miembro:
--
--   create policy "tenants_update_members" on public.tenants for update
--     using      (id in (select public.auth_tenant_ids()))
--     with check (id in (select public.auth_tenant_ids()));
--
-- No dice nada de QUÉ COLUMNAS, y hasta hoy no había ningún grant de columna
-- sobre la tabla. RLS y privilegios son dos rejas distintas: la policy contesta
-- "esta fila es tuya" y nadie contestaba "esta columna no".
--
-- Con el cliente de navegador (`src/lib/supabase/client.ts`) el token de sesión
-- vive del lado del usuario, así que un dueño logueado podía mandar
--
--   PATCH /rest/v1/tenants?id=eq.<el suyo>   {"plan": "premium"}
--
-- y subirse de plan sin pagar. No hacía falta ningún exploit: era la API
-- pública funcionando como estaba configurada. `slug`, `country` y `timezone`
-- estaban igual de abiertos —el slug es la URL pública del negocio, y pisarlo
-- es apropiarse de la dirección de otro si estuviera libre.
--
-- ## El arreglo
--
-- Se revoca el UPDATE entero y se devuelve SÓLO sobre las columnas que la app
-- escribe de verdad. Hoy son dos, las dos de `settings-actions.ts`, que es el
-- único lugar del código que actualiza `tenants` con el cliente de sesión.
--
-- Elegido así, y no como una lista de columnas prohibidas, porque una lista
-- negra se queda vieja sola: la columna que alguien agregue mañana nace
-- escribible y nadie se entera. Con la lista blanca nace cerrada, y abrirla es
-- una decisión que se escribe en una migración.
--
-- ## Lo que NO toca
--
-- `plan` lo sigue moviendo el webhook, porque `apply_subscription_payment` es
-- `security definer`: corre con los privilegios del dueño de la función, y los
-- grants de columna no lo alcanzan. Lo mismo vale para `create_business` y
-- `attach_subscription_checkout`. Un cobro que llega sigue aplicándose igual.
--
-- Tampoco toca el SELECT: los negocios se siguen leyendo como siempre.
-- ============================================================

-- El revoke va sobre los tres roles y no sólo sobre `authenticated`.
--
-- `anon` hoy no puede tocar ninguna fila —`auth_tenant_ids()` le devuelve vacío
-- porque no hay `auth.uid()`— así que la policy ya lo frenaba. Pero eso lo
-- garantiza la OTRA reja, y apoyar un permiso de escritura en que la reja de al
-- lado aguante es exactamente la forma del agujero que esta migración cierra.
--
-- `public` entra porque los privilegios se heredan de ahí: un grant que quedara
-- puesto sobre `public` alcanzaría a cualquier rol, incluidos los dos de
-- arriba, y el revoke sobre ellos no se notaría.
revoke update on public.tenants from anon, authenticated, public;

-- La marca es lo único que un negocio edita de sí mismo, desde
-- `/panel/configuracion`. Si mañana esa pantalla suma un campo, se agrega acá:
-- que haga falta tocar una migración para abrir una columna es la propiedad que
-- se está comprando, no un costo accidental.
grant update (brand_color, logo_url) on public.tenants to authenticated;

comment on table public.tenants is
  'Negocios de la plataforma. El UPDATE desde una sesión está limitado por '
  'grants de columna a (brand_color, logo_url): plan, slug, country y timezone '
  'sólo se mueven desde funciones security definer. Ver migración '
  '20260830120001_tenants_column_grants.sql.';
