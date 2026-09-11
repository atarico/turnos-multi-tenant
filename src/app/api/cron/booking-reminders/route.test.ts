import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests del endpoint del cron.
 *
 * Del otro lado hay un proceso que le escribe a los clientes de TODOS los
 * negocios. Así que lo que se prueba acá es casi todo el portón: quién puede
 * dispararlo y —sobre todo— qué pasa cuando el secreto no está configurado.
 *
 * La respuesta a eso último es lo que separa este endpoint de las variables
 * del correo. Ausentes, aquéllas apagan una función. Ausente el secreto, un
 * endpoint que se abriera dejaría a cualquiera que descubra la URL mandando
 * correos a nombre de negocios ajenos.
 */

let env: Record<string, string | undefined> = {};
let envThrows = false;
vi.mock("@/lib/env", () => ({
  serverEnv: () => {
    if (envThrows) throw new Error("entorno inválido");
    return env;
  },
}));

const sendDueReminders = vi.fn();
vi.mock("@/modules/notifications/application/send-reminders", () => ({
  sendDueReminders: () => sendDueReminders(),
}));

const { GET } = await import("./route");

const SECRET = "un-secreto-largo-de-cron";

function call(authorization?: string): Promise<Response> {
  return GET(
    new Request("https://app.turnos.com/api/cron/booking-reminders", {
      headers: authorization ? { authorization } : {},
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  envThrows = false;
  env = { CRON_SECRET: SECRET };
  sendDueReminders.mockResolvedValue({
    due: 3,
    sent: 3,
    failed: 0,
    notConfigured: false,
    failedToRead: false,
  });
});

describe("GET /api/cron/booking-reminders", () => {
  it("con el secreto correcto manda los recordatorios", async () => {
    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(sendDueReminders).toHaveBeenCalledOnce();
  });

  /**
   * El resumen viaja en la respuesta porque es lo ÚNICO que queda de la
   * corrida. Es lo que alguien va a leer en el log de Vercel el día que un
   * cliente diga que no recibió su recordatorio.
   */
  it("devuelve el resumen de lo que hizo", async () => {
    const response = await call(`Bearer ${SECRET}`);

    expect(await response.json()).toMatchObject({ due: 3, sent: 3, failed: 0 });
  });

  /**
   * EL CASO QUE MÁS IMPORTA. Sin secreto configurado el portón queda CERRADO.
   *
   * La tentación es dejarlo abierto "hasta que se configure", igual que el
   * correo se queda apagado. No es lo mismo: apagado, el correo no le hace
   * nada a nadie; abierto, este endpoint le manda mails a los clientes de
   * todos los negocios a pedido de cualquiera que adivine la URL.
   */
  it("sin secreto configurado NO dispara nada y rechaza", async () => {
    env = {};

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(401);
    expect(sendDueReminders).not.toHaveBeenCalled();
  });

  it("sin header de autorización rechaza", async () => {
    const response = await call();

    expect(response.status).toBe(401);
    expect(sendDueReminders).not.toHaveBeenCalled();
  });

  it("con un secreto que no es el correcto rechaza", async () => {
    const response = await call("Bearer otro-secreto-cualquiera");

    expect(response.status).toBe(401);
    expect(sendDueReminders).not.toHaveBeenCalled();
  });

  /**
   * Un token de largo distinto no puede reventar el endpoint. `timingSafeEqual`
   * TIRA ante buffers de largos distintos, y un 500 que se provoca a voluntad
   * es una forma barata de tirar abajo el proceso. Por eso los dos lados pasan
   * por sha256 antes de compararse. Misma lección que `webhook-signature.ts`.
   */
  it("un token de cualquier largo devuelve 401, nunca 500", async () => {
    for (const token of ["", "x", "x".repeat(5000)]) {
      const response = await call(`Bearer ${token}`);
      expect(response.status).toBe(401);
    }
  });

  it("un esquema que no es Bearer rechaza", async () => {
    const response = await call(`Basic ${SECRET}`);

    expect(response.status).toBe(401);
  });

  /**
   * Y si el entorno entero está roto, 500 y no un 401 que mentiría sobre la
   * causa. `serverEnv()` tira cuando falta algo obligatorio, y esa excepción
   * no puede escaparse: sería un 500 igual, pero sin pasar por acá y con un
   * stack en el log en vez de una respuesta.
   */
  it("un entorno inválido devuelve 500 sin dejar escapar la excepción", async () => {
    envThrows = true;

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(sendDueReminders).not.toHaveBeenCalled();
  });
});
