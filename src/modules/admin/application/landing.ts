import { isSuperAdmin } from "./queries";

/** Donde alguien recién registrado crea su negocio. */
export const ONBOARDING_PATH = "/panel/bienvenida";

/** Donde vive un operador de plataforma. */
export const OPERATOR_PATH = "/admin";

/**
 * Adónde va una cuenta autenticada que no tiene ningún negocio.
 *
 * La pregunta parece tener una sola respuesta y tiene dos, porque
 * `getCurrentTenant()` devuelve `null` en dos situaciones opuestas:
 *
 *   1. alguien que se acaba de registrar y todavía no creó su negocio;
 *   2. un operador de plataforma, que no es miembro de NINGUNO por diseño
 *      —la migración `20260828120003_platform_admins.sql` lo dice explícito—
 *      porque su poder se inyecta dentro de `auth_tenant_ids()` en vez de
 *      pasar por una fila de `memberships`.
 *
 * Hasta acá el panel leía ese `null` como si fuera siempre el caso 1 y mandaba
 * a todo el mundo al onboarding. Para el operador eso es un callejón: le pide
 * crear un negocio que no quiere, y `/admin` queda inalcanzable salvo tipeando
 * la URL a mano.
 *
 * Esta función existe para que la desambiguación viva en UN solo lugar. Las
 * dos pantallas que expulsan por falta de negocio (`/panel` y
 * `/panel/bienvenida`) tienen que contestar lo mismo: si una se olvidara, el
 * operador rebotaría entre las dos.
 *
 * El destino por defecto es el onboarding, no el panel de plataforma. Es
 * deliberado: `isSuperAdmin()` falla cerrado, así que una RPC caída devuelve
 * `false`, y la consecuencia de equivocarse hacia el onboarding es una pantalla
 * de más para el operador, mientras que equivocarse hacia `/admin` sería
 * mostrarle la plataforma entera a quien no pudimos identificar.
 */
export async function landingWithoutTenant(): Promise<string> {
  return (await isSuperAdmin()) ? OPERATOR_PATH : ONBOARDING_PATH;
}
