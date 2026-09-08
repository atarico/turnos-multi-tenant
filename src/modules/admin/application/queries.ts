import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import type { AdminTenant } from "../domain/types";

/**
 * Las dos consultas van por `@/lib/supabase/server`, el cliente de SESIÓN.
 * Nunca por `@/lib/supabase/admin`: ese saltea la RLS, y usarlo acá haría que
 * la pantalla mostrara todos los negocios aun cuando quien mira no es super
 * admin. El aislamiento quedaría colgando de este `if` en vez de la base.
 *
 * Con el cliente de sesión no hace falta ningún filtro: `auth_tenant_ids()` le
 * devuelve TODOS los tenants a un super admin, así que la policy que ya existe
 * sobre `tenants` hace el trabajo sola.
 */

const COLUMNS = "id, slug, name, country, plan, created_at";

/**
 * ¿Quien está mirando es super admin de la plataforma?
 *
 * Va por RPC porque `platform_admins` tiene RLS sin ninguna policy y los grants
 * revocados: es ilegible desde PostgREST por diseño, y `is_super_admin()` es
 * `security definer` justamente para ser la única rendija.
 *
 * Devuelve `false` ante CUALQUIER fallo, incluida una excepción, y por eso el
 * `try` abarca también la creación del cliente. No es prolijidad: esto es un
 * guard de ruta, y una promesa rechazada acá le devuelve un 500 a un
 * desconocido logueado. La ruta contesta 404 para no admitir que existe, y un
 * 500 en una ruta que "no existe" la delata igual.
 *
 * Fallar cerrado es gratis para el admin de verdad (recarga y entra) y es la
 * única respuesta segura ante la duda.
 */
export async function isSuperAdmin(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("is_super_admin");

    if (error) return false;
    // `=== true` y no un truthy: la función devuelve boolean, y cualquier otra
    // cosa que llegue por acá es una respuesta que no entendemos.
    return data === true;
  } catch {
    return false;
  }
}

/**
 * Todos los negocios de la plataforma, del alta más reciente a la más vieja:
 * el negocio que se dio de alta recién es el que uno viene a buscar.
 *
 * Devuelve `Result` —y no un array pelado con `[]` de fallback como hacen las
 * consultas del panel de cada dueño— porque acá el fallo y el vacío no se
 * pueden confundir. Esta es la ÚNICA vista de la plataforma: pintar una lista
 * vacía porque la consulta falló le diría al dueño que no tiene clientes.
 * Ese es también el motivo de que `isSuperAdmin` de arriba haga lo contrario:
 * allá "no sé" y "no" tienen que dar lo mismo, acá no pueden.
 */
export async function listAllTenants(): Promise<Result<AdminTenant[]>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tenants")
      .select(COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      return err(
        appError(
          "admin_tenants_query_failed",
          "No pudimos cargar los negocios de la plataforma.",
        ),
      );
    }
    return ok((data ?? []) as unknown as AdminTenant[]);
  } catch {
    return err(
      appError(
        "admin_tenants_query_failed",
        "No pudimos cargar los negocios de la plataforma.",
      ),
    );
  }
}
