-- ============================================================
-- Bucket de logos de negocio
--
-- Guarda el logo que el dueño sube y que se pinta en su página pública.
-- La ruta de cada objeto es `{tenant_id}/{nombre}`, y ese primer segmento es
-- lo único que decide de quién es el archivo.
--
-- Por qué la carpeta ES el tenant y no una columna aparte: `storage.objects`
-- no tiene `tenant_id`, así que la política sólo puede mirar la ruta. Poner el
-- id adelante convierte el path en la clave de autorización, que es el único
-- dato que la política puede leer sin joins.
-- ============================================================

-- ------------------------------------------------------------
-- El bucket
--
-- `public = true`: el logo se muestra en `/{slug}`, que es anónima. Un bucket
-- privado obligaría a firmar una URL en CADA render de esa página, para un
-- archivo cuyo contenido es deliberadamente público — el negocio lo sube
-- justamente para que lo vean.
--
-- `file_size_limit` y `allowed_mime_types` duplican lo que ya valida la app, y
-- están a propósito: la app protege el camino del formulario, pero un cliente
-- autenticado puede pegarle directo a la API de Storage. La app es comodidad;
-- esto es el límite.
--
-- SVG NO está en la lista, y no es un olvido: es XML que admite `<script>`, y
-- en un bucket público abrir su URL lo ejecuta en nuestro origen. Ver
-- `src/modules/tenants/domain/logo.ts`.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-logos',
  'tenant-logos',
  true,
  2097152, -- 2 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------------------
-- Quién escribe
--
-- Sólo un miembro del negocio, y sólo dentro de la carpeta de SU negocio. La
-- comparación es contra `auth_tenant_ids()`, la misma función que gobierna el
-- resto del esquema: si mañana cambia qué significa "pertenecer a un negocio",
-- cambia en un solo lugar.
--
-- El casteo va de uuid A TEXTO y no al revés. `foldername(name)` devuelve el
-- path partido, y ahí puede haber cualquier cosa: castear ese texto a uuid
-- haría fallar la política entera con un error de conversión ante una ruta
-- basura, en vez de simplemente no matchear.
-- ------------------------------------------------------------
drop policy if exists "tenant_logos_insert_members" on storage.objects;
create policy "tenant_logos_insert_members"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] in (
      select t::text from public.auth_tenant_ids() as t
    )
  );

-- `using` filtra las filas que ve, `with check` valida cómo quedan: sin las dos
-- se podría MOVER un objeto propio a la carpeta de otro negocio.
drop policy if exists "tenant_logos_update_members" on storage.objects;
create policy "tenant_logos_update_members"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] in (
      select t::text from public.auth_tenant_ids() as t
    )
  )
  with check (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] in (
      select t::text from public.auth_tenant_ids() as t
    )
  );

-- Borrar hace falta para reemplazar el logo sin dejar huérfanos acumulándose.
drop policy if exists "tenant_logos_delete_members" on storage.objects;
create policy "tenant_logos_delete_members"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] in (
      select t::text from public.auth_tenant_ids() as t
    )
  );

-- ------------------------------------------------------------
-- Quién lee
--
-- La lectura del archivo servido no pasa por acá: en un bucket público, la ruta
-- `/storage/v1/object/public/...` se sirve sin RLS, que es exactamente lo que
-- necesita la página anónima.
--
-- Esta política es para la API de objetos: el dueño autenticado tiene que poder
-- LISTAR lo que hay en su carpeta para reemplazarlo o borrarlo. Sin ella, el
-- borrado del logo anterior no encuentra nada que borrar.
-- ------------------------------------------------------------
drop policy if exists "tenant_logos_select_members" on storage.objects;
create policy "tenant_logos_select_members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] in (
      select t::text from public.auth_tenant_ids() as t
    )
  );
