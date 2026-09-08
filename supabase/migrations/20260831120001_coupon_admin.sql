-- ============================================================
-- Crear, listar y apagar cupones desde el panel de plataforma.
--
-- La tabla `coupons` es deny-all y sus grants están revocados: una lista de
-- cupones legible desde una sesión es una lista de códigos de descuento
-- publicada. Así que el operador tampoco la lee directo — pasa por estas tres
-- funciones `security definer`, con la misma reja que las de cortesía:
-- `is_super_admin()` ADENTRO, no un grant a un rol.
--
-- Por qué adentro: `security definer` corre con los privilegios del dueño de la
-- función. Sin el chequeo, cualquier usuario logueado que adivine el nombre se
-- lista todos los códigos de descuento de la plataforma.
--
-- No hay función para BORRAR un cupón, y es deliberado. Apagarlo alcanza: las
-- suscripciones que ya lo usaron guardan su propia copia del descuento, así que
-- apagar no le sube el precio a nadie. Borrar la fila perdería el `note` que
-- explica para qué se creó, que es justo lo que alguien va a querer saber
-- cuando encuentre un cliente pagando distinto.
-- ============================================================

create or replace function public.create_coupon(
  p_code            text,
  p_discount_bps    int,
  p_note            text        default null,
  p_expires_at      timestamptz default null,
  p_max_redemptions int         default null,
  p_now             timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if not public.is_super_admin() then
    raise exception 'solo un operador de plataforma puede crear cupones'
      using errcode = 'insufficient_privilege';
  end if;

  -- Un vencimiento ya pasado crearía un cupón muerto al nacer: se vería en la
  -- lista como un cupón y ningún checkout lo aceptaría. Un estado que se ve de
  -- una forma y se comporta de otra es peor que un error.
  if p_expires_at is not null and p_expires_at <= p_now then
    raise exception 'el vencimiento del cupon tiene que ser futuro'
      using errcode = 'check_violation';
  end if;

  -- El código se normaliza ACÁ y no se le pide al llamador: quien lo tipea lo
  -- hace en un formulario, y que el cupón funcione no puede depender de si
  -- alguien apretó Bloq Mayús.
  insert into public.coupons (
    code, discount_bps, note, expires_at, max_redemptions, created_by
  )
  values (
    v_code, p_discount_bps, nullif(btrim(coalesce(p_note, '')), ''),
    p_expires_at, p_max_redemptions, auth.uid()
  );
exception
  -- Se traduce el choque de clave a un mensaje que se puede accionar. Dejar
  -- salir el error de Postgres mostraría el nombre del índice en pantalla.
  when unique_violation then
    raise exception 'ya existe un cupon con ese codigo'
      using errcode = 'unique_violation';
end;
$$;


create or replace function public.list_coupons()
returns setof public.coupons
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'solo un operador de plataforma puede ver los cupones'
      using errcode = 'insufficient_privilege';
  end if;

  -- Del más nuevo al más viejo: el que se acaba de crear es el que se está
  -- por mandar, y tiene que estar arriba sin buscarlo.
  return query
    select * from public.coupons order by created_at desc;
end;
$$;


create or replace function public.set_coupon_active(
  p_code   text,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if not public.is_super_admin() then
    raise exception 'solo un operador de plataforma puede apagar un cupon'
      using errcode = 'insufficient_privilege';
  end if;

  update public.coupons set active = p_active where code = v_code;

  if not found then
    raise exception 'no existe el cupon %', v_code
      using errcode = 'no_data_found';
  end if;
end;
$$;


-- El operador las llama con SU sesión: `created_by` sale de `auth.uid()`, y con
-- la service key no habría a quién anotar. La autorización real la hace
-- `is_super_admin()` adentro de cada una.
revoke execute on function public.create_coupon(text, int, text, timestamptz, int, timestamptz) from public, anon;
revoke execute on function public.list_coupons() from public, anon;
revoke execute on function public.set_coupon_active(text, boolean) from public, anon;

grant execute on function public.create_coupon(text, int, text, timestamptz, int, timestamptz) to authenticated;
grant execute on function public.list_coupons() to authenticated;
grant execute on function public.set_coupon_active(text, boolean) to authenticated;
