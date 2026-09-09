import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests del transporte de correo.
 *
 * Lo que se cuida acá es que NADA de esto pueda voltear una reserva. Un mail
 * es un accesorio del turno, no una parte de él: el turno ya está tomado
 * cuando esto corre, y el peor final posible es que un proveedor caído
 * convierta una reserva buena en un error en la cara del cliente.
 *
 * Por eso los tres desenlaces se distinguen y ninguno tira: mandado, apagado
 * (no hay credenciales) y falló.
 */

let env: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { sendEmail } = await import("./email");

const mail = {
  to: "cliente@correo.com",
  subject: "Tu turno",
  text: "texto",
  html: "<p>html</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  env = {
    RESEND_API_KEY: "re_test_key",
    NOTIFICATIONS_FROM_EMAIL: "turnos@negocio.com",
  };
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "abc" }) });
});

describe("sendEmail", () => {
  it("manda el mail y lo reporta como mandado", async () => {
    const result = await sendEmail(mail);

    expect(result.ok && result.value).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("va con la key en el header y el remitente configurado en el cuerpo", async () => {
    await sendEmail(mail);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body).from).toBe("turnos@negocio.com");
    expect(JSON.parse(init.body).to).toEqual(["cliente@correo.com"]);
  });

  /**
   * SIN CREDENCIALES NO ES UN ERROR, es el estado en el que esto se despliega
   * antes de que exista la cuenta y el dominio verificado. Tratarlo como
   * fallo llenaría los logs de ruido en cada reserva y escondería los fallos
   * de verdad. Se distingue y no se toca la red.
   */
  it("sin API key no manda nada y lo dice, sin fallar", async () => {
    env = { NOTIFICATIONS_FROM_EMAIL: "turnos@negocio.com" };

    const result = await sendEmail(mail);

    expect(result.ok && result.value).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Y sin remitente tampoco, aunque haya key. Un `from` de un dominio sin
   * verificar lo rechaza el proveedor en CADA envío: pedirle a la red que
   * confirme algo que ya sabemos que falta es gastar el timeout de una
   * reserva por nada.
   */
  it("con key pero sin remitente tampoco toca la red", async () => {
    env = { RESEND_API_KEY: "re_test_key" };

    const result = await sendEmail(mail);

    expect(result.ok && result.value).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un rechazo del proveedor vuelve como error, no como éxito", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: "domain not verified" }),
    });

    const result = await sendEmail(mail);

    expect(!result.ok && result.error.code).toBe("email_send_failed");
  });

  /**
   * EL CAMINO QUE TIRA, que es el que rompe una reserva si se escapa. `fetch`
   * revienta por red, por DNS y por timeout, y ninguna de las tres devuelve
   * una respuesta que se pueda mirar.
   */
  it("una excepción de red vuelve como error y no se escapa", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const result = await sendEmail(mail);

    expect(!result.ok && result.error.code).toBe("email_send_failed");
  });

  /**
   * Con timeout, y no a la espera de que el proveedor conteste cuando quiera.
   * Esto corre DENTRO de la reserva: sin corte, un proveedor lento deja al
   * cliente mirando un spinner por un mail que ni siquiera pidió.
   */
  it("le pone un límite de tiempo a la llamada", async () => {
    await sendEmail(mail);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.signal).toBeDefined();
  });
});
