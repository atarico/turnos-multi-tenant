import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

/**
 * ¿La sesión actual es la DUEÑA del negocio actual?
 *
 * Conectar, desconectar y prender los pagos deciden adónde cae la plata de los
 * clientes, así que no alcanza con ser miembro: tiene que ser `owner`. Se
 * pregunta por la sesión (RLS: cada usuario sólo ve sus propias membresías) y
 * se falla CERRADO: si la consulta falla o tira, no es dueño.
 *
 * Es el chequeo de las rutas y de la desconexión. El toggle además lo vuelve a
 * hacer la base dentro de `set_online_payments`; acá es la primera puerta y la
 * que protege lo que la base no ve (el borrado por el cliente admin).
 *
 * Códigos: `no_session` (sin sesión o sin negocio), `not_owner`.
 */
export async function currentOwnerTenant(): Promise<Result<{ tenantId: string }>> {
  const notOwner = () =>
    err(appError("not_owner", "Sólo el dueño del negocio puede hacer esto."));

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return err(appError("no_session", "No encontramos tu negocio. Volvé a ingresar."));
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return err(appError("no_session", "No encontramos tu negocio. Volvé a ingresar."));
    }

    const { data, error } = await supabase
      .from("memberships")
      .select("role")
      .eq("user_id", user.id)
      .eq("tenant_id", tenant.id)
      .eq("role", "owner")
      .maybeSingle();
    if (error || !data) return notOwner();
  } catch {
    return notOwner();
  }

  return ok({ tenantId: tenant.id });
}
