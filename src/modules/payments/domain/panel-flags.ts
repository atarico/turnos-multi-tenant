/**
 * Banderas fijas con las que el flujo de pagos le habla a `/panel/pagos`.
 *
 * Mismo criterio que el link vencido de `/recuperar`: la URL trae una CLAVE,
 * la pantalla la COMPARA contra esta tabla y pinta el texto que vive acá. Lo
 * que venga en la URL nunca se imprime, así que un link armado a mano no puede
 * meter una frase propia dentro de nuestro diseño.
 */

export type FlagTone = "ok" | "info" | "error";

export const PAYMENTS_FLAGS = {
  conectado: {
    tone: "ok",
    message: "Listo, conectamos tu cuenta de Mercado Pago.",
  },
  cancelado: {
    tone: "info",
    message: "Cancelaste la conexión en Mercado Pago, así que no cambió nada.",
  },
  error: {
    tone: "error",
    message:
      "No pudimos conectar tu cuenta de Mercado Pago. Probá de nuevo; si sigue fallando, escribinos.",
  },
  "no-configurado": {
    tone: "error",
    message: "Los pagos online todavía no están disponibles en este entorno.",
  },
  "sin-permiso": {
    tone: "error",
    message: "Sólo el dueño del negocio puede cambiar los pagos online.",
  },
  activado: {
    tone: "ok",
    message:
      "Pagos online activados. Desde ahora tus clientes pagan al reservar.",
  },
  desactivado: {
    tone: "info",
    message: "Pagos online desactivados. Tus clientes reservan sin pagar.",
  },
  desconectado: {
    tone: "info",
    message:
      "Desconectamos tu cuenta de Mercado Pago y apagamos los pagos online.",
  },
  "sin-plan": {
    tone: "error",
    message: "Los pagos online requieren el plan Pro o superior.",
  },
  "sin-conexion": {
    tone: "error",
    message: "Primero conectá tu cuenta de Mercado Pago.",
  },
  fallo: {
    tone: "error",
    message: "No pudimos hacer el cambio. Intentá de nuevo en un momento.",
  },
} as const satisfies Record<string, { tone: FlagTone; message: string }>;

export type PaymentsFlag = keyof typeof PAYMENTS_FLAGS;

/** La bandera si es una de las nuestras; si no, `null`. Nunca devuelve el texto de la URL. */
export function parsePaymentsFlag(raw: string | string[] | undefined): PaymentsFlag | null {
  if (typeof raw !== "string") return null;
  return Object.hasOwn(PAYMENTS_FLAGS, raw) ? (raw as PaymentsFlag) : null;
}

/**
 * Traduce el error de `set_online_payments` a una bandera.
 *
 * La función SQL distingue los motivos por `errcode` (42501 = no es el dueño)
 * y por mensaje (los dos P0001: plan y conexión). Cualquier otra cosa es un
 * fallo genérico: no se le muestra al dueño el texto crudo de la base.
 */
export function classifyToggleError(error: {
  code?: string | null;
  message?: string | null;
}): PaymentsFlag {
  if (error.code === "42501") return "sin-permiso";
  const message = error.message ?? "";
  if (message.includes("plan Pro")) return "sin-plan";
  if (message.includes("no está conectado")) return "sin-conexion";
  return "fallo";
}
