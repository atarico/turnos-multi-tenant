import "server-only";

import { appError, err, ok, type Result } from "@/core/result";
import { serverEnv } from "@/lib/env";

const ENDPOINT = "https://api.resend.com/emails";

/**
 * Cuánto se espera al proveedor antes de darlo por perdido.
 *
 * Corto A PROPÓSITO, y más corto que el de Mercado Pago: allá del otro lado
 * hay plata y conviene esperar; acá hay un accesorio del turno. Esto corre
 * dentro de la reserva, así que cada segundo que el proveedor tarda es un
 * segundo que el cliente mira un spinner por un mail que ni siquiera pidió.
 */
const TIMEOUT_MS = 5_000;

/**
 * Cómo terminó el intento, cuando terminó bien.
 *
 * `not_configured` es ÉXITO y no un caso raro: es el estado en el que esto se
 * despliega antes de que exista la cuenta del proveedor y el dominio
 * verificado. Tratarlo como fallo llenaría los logs de ruido en cada reserva y
 * escondería los fallos de verdad — que son los que hay que ir a mirar.
 */
export type SendOutcome = "sent" | "not_configured";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const failed = () =>
  err(
    appError(
      "email_send_failed",
      "No pudimos enviar el correo de confirmación.",
    ),
  );

/**
 * Manda un correo, o dice por qué no.
 *
 * NUNCA TIRA, y esa es su única regla dura. Quien la llama ya tiene una
 * reserva tomada y confirmada en la base: una excepción que se escape de acá
 * convertiría una reserva buena en un error en la cara del cliente, que es
 * exactamente al revés de para qué existe este módulo. Los tres desenlaces
 * salen por el `Result`.
 *
 * `fetch` pelado con `AbortSignal.timeout`, igual que `mercadopago.ts`: el
 * repo no trae SDK para hablar con una API que son dos campos y un header, y
 * un paquete más es una superficie más que mantener.
 */
export async function sendEmail(
  email: OutgoingEmail,
): Promise<Result<SendOutcome>> {
  const { RESEND_API_KEY, NOTIFICATIONS_FROM_EMAIL } = serverEnv();

  // Se chequean las DOS antes de tocar la red. Con la key puesta y un
  // remitente de dominio sin verificar, el proveedor rechaza cada envío: pedir
  // a la red que confirme algo que ya sabemos que falta es gastar el timeout
  // de una reserva por nada.
  if (!RESEND_API_KEY || !NOTIFICATIONS_FROM_EMAIL) {
    return ok("not_configured");
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: NOTIFICATIONS_FROM_EMAIL,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Red, DNS y timeout caen todos acá, y ninguno devuelve una respuesta que
    // se pueda mirar. Es el camino que rompe una reserva si se escapa.
    return failed();
  }

  if (!response.ok) return failed();

  return ok("sent");
}
