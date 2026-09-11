-- ============================================================
-- Avisarle al NEGOCIO que le llegó una reserva.
--
-- Hasta hoy el cliente se lleva un mail de confirmación (PR #68) y un
-- recordatorio (PR #70), pero el dueño del negocio no se entera de nada salvo
-- que abra el panel. Esta migración no manda ningún correo: sólo contesta una
-- pregunta —a qué direcciones hay que avisarle de este negocio— porque esa
-- respuesta no existe en ningún lado de `src/`.
--
-- POR QUÉ HACE FALTA UNA FUNCIÓN NUEVA Y NO ALCANZA CON LEER UNA TABLA: el
-- mail del negocio vive ÚNICAMENTE en `auth.users.email`. `memberships` no
-- tiene columna de correo, `profiles` sólo tiene nombre y avatar, y `tenants`
-- no tiene un contacto propio. La única forma de llegar al mail es cruzar
-- `memberships` con `auth.users`, y `auth.users` es un esquema que ninguna
-- sesión de cliente puede leer directamente — ni con RLS a favor, porque RLS
-- no existe ahí.
--
-- QUIÉN RECIBE EL AVISO: los miembros con rol `owner` o `admin` del negocio.
-- `staff` queda afuera a propósito: son quienes atienden turnos puntuales, no
-- quienes administran el negocio, y avisarles de cada reserva nueva del local
-- entero sería ruido para ellos, no una ayuda.
--
-- `security definer` y grant SÓLO a `service_role`, igual que
-- `bookings_due_for_reminder()` en 20260909120001: esta función expone el
-- mail de cuentas de `auth.users`, que es exactamente el tipo de dato que no
-- puede quedar al alcance de una sesión de `authenticated` o `anon`. La llama
-- la aplicación desde el servidor, después de confirmar la reserva.
-- ============================================================

create or replace function public.tenant_notification_recipients(
  p_tenant_id uuid
)
returns table (
  email text
)
language sql
stable
security definer set search_path = public
as $$
  select u.email
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id
    and m.role in ('owner', 'admin')
    -- Sin esto se le devolvería a quien llama una fila vacía o en blanco: una
    -- cuenta puede existir sin mail verificado (alta por teléfono, por
    -- ejemplo), y esa fila no sirve como destinatario de nada.
    and u.email is not null
    and u.email <> '';
$$;

comment on function public.tenant_notification_recipients(uuid) is
  'Los mails de owner/admin de un negocio, para avisarles de una reserva '
  'nueva. Cruza memberships con auth.users, que ninguna sesión de cliente '
  'puede leer — por eso es security definer y sólo la llama el service_role.';

revoke execute on function public.tenant_notification_recipients(uuid)
  from public, anon, authenticated;
grant  execute on function public.tenant_notification_recipients(uuid) to service_role;
