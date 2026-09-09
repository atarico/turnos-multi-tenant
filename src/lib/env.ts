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
  /**
   * Token de acceso de Mercado Pago. Cobra plata: nunca sale del servidor.
   *
   * Va sin `NEXT_PUBLIC_`, y el módulo que lo lee importa `server-only` para
   * que un import desde un Client Component rompa el build en vez de filtrarlo
   * al bundle.
   */
  MERCADOPAGO_ACCESS_TOKEN: z.string().min(1),
  /**
   * Secreto de la firma del webhook. NO es el access token y no se puede
   * derivar de él: se copia del panel de Mercado Pago, en la configuración de
   * la notificación (Tus integraciones > tu aplicación > Webhooks).
   *
   * Es lo único que separa una notificación de Mercado Pago de una que mandó
   * cualquiera que sepa la URL, y del otro lado hay una función que activa
   * planes pagos. Sin esto configurado el portón queda CERRADO —
   * `isValidWebhookSignature` devuelve false ante un secreto vacío — y ningún
   * cobro se aplica.
   */
  MERCADOPAGO_WEBHOOK_SECRET: z.string().min(1),
  /**
   * Credenciales del correo saliente. LAS DOS SON OPCIONALES, y eso es una
   * decisión y no un descuido.
   *
   * `serverEnv()` valida todo junto y TIRA si falta algo, así que una variable
   * obligatoria acá voltearía la aplicación entera —reservas incluidas— el día
   * que el mail no esté configurado. Sería cambiar "el cliente no recibe un
   * mail" por "nadie puede reservar", que es un negocio pésimo.
   *
   * Ausentes significa NOTIFICACIONES APAGADAS, y el módulo que las manda lo
   * dice explícitamente en vez de fallar en silencio. Así esto se puede
   * desplegar antes de tener la cuenta y el dominio verificado, y se prende
   * cuando estén.
   *
   * `NOTIFICATIONS_FROM_EMAIL` va aparte de la key porque el remitente tiene
   * que ser de un dominio verificado ante el proveedor: con la key puesta y un
   * remitente cualquiera, el proveedor rechaza cada envío.
   */
  /**
   * El secreto con el que el cron se identifica ante su propio endpoint.
   *
   * Opcional por lo mismo que las de correo —una obligatoria voltearía la app
   * entera— pero con una diferencia importante en cómo se comporta ausente:
   * ahí el endpoint queda CERRADO, no abierto. Sin secreto no hay forma de
   * distinguir al cron de cualquiera que descubra la URL, y del otro lado hay
   * un proceso que le escribe a los clientes de todos los negocios.
   *
   * Vercel lo manda como `Authorization: Bearer <secreto>` en cada corrida.
   */
  CRON_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  NOTIFICATIONS_FROM_EMAIL: z.email().optional(),
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
