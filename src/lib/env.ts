import { z } from "zod";

/**
 * Esquema de variables de entorno del servidor.
 *
 * Incluye la SERVICE_ROLE_KEY, que NUNCA debe llegar al cliente. Por eso este
 * módulo solo se importa desde código server-side (Server Components, Actions,
 * Route Handlers). El browser client lee las NEXT_PUBLIC_* directamente.
 */
const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  /**
   * Salt del hash de IP que frena el spam de reservas anónimas.
   *
   * Sin salt el freno no protege a nadie: IPv4 son 4 mil millones de valores,
   * así que cualquiera con acceso de lectura a la base reconstruye las IPs
   * originales por fuerza bruta. Se pide largo para que no se resuelva con una
   * cadena de diccionario.
   */
  BOOKING_IP_SALT: z.string().min(16, "Usá al menos 16 caracteres"),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/**
 * Valida y devuelve las variables de entorno del servidor.
 *
 * Lazy a propósito: se valida la primera vez que se la llama, NO al importar el
 * módulo. Así las páginas que no dependen de Supabase (landing, demo de UI)
 * renderizan sin requerir credenciales reales. Falla con un mensaje claro
 * apenas algo intente usar Supabase sin configurar el entorno.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Variables de entorno inválidas o faltantes:\n${issues}\n\n` +
        `Completá tu .env.local tomando .env.example como referencia.`,
    );
  }

  cached = parsed.data;
  return cached;
}
