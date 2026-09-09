import { beforeEach, describe, expect, it, vi } from "vitest";

import { appError, err, ok } from "@/core/result";

/**
 * Tests del proceso que manda los recordatorios.
 *
 * Corre solo, una vez por día, sin nadie mirando. Eso cambia lo que hay que
 * cuidar: no hay una persona esperando una respuesta, pero tampoco hay nadie
 * que note que algo salió mal. Las tres obsesiones son:
 *
 * 1. **Marcar DESPUÉS de que el proveedor aceptó, y de a uno.** Al revés, un
 *    corte a la mitad deja gente sin aviso y marcada como avisada — el único
 *    fallo de este sistema que después nadie puede detectar.
 * 2. **Que un fallo suelto no se lleve el lote.** Si el mail 3 de 40 falla,
 *    los 37 restantes tienen que salir igual.
 * 3. **Que no tire nunca.** Del otro lado hay un endpoint HTTP: una excepción
 *    que se escape se convierte en un 500 que el cron va a reintentar, y el
 *    reintento manda de nuevo todo lo que ya salió.
 */

const sendEmail = vi.fn();
vi.mock("./email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

let dueRows: { data: unknown; error: unknown } = { data: [], error: null };
const markCalls: string[] = [];
let clientFailure: Error | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (clientFailure) throw clientFailure;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "bookings_due_for_reminder") return dueRows;
        markCalls.push(args.p_booking_id as string);
        return { data: true, error: null };
      },
    };
  },
}));

const { sendDueReminders } = await import("./send-reminders");

function row(id: string) {
  return {
    booking_id: id,
    tenant_name: "Peluquería Nube",
    timezone: "America/Argentina/Buenos_Aires",
    service_name: "Corte y barba",
    staff_name: "Ana",
    starts_at: "2026-09-15T13:30:00.000Z",
    customer_name: "Marcos",
    customer_email: `${id}@correo.com`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  markCalls.length = 0;
  clientFailure = null;
  dueRows = { data: [row("a"), row("b")], error: null };
  sendEmail.mockResolvedValue(ok("sent"));
});

describe("sendDueReminders", () => {
  it("le manda a cada uno de los que tocan", async () => {
    const summary = await sendDueReminders();

    expect(summary).toMatchObject({ due: 2, sent: 2, failed: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("y marca a los que salieron, para que mañana no salgan de nuevo", async () => {
    await sendDueReminders();

    expect(markCalls).toEqual(["a", "b"]);
  });

  /**
   * EL ORDEN QUE NO SE PUEDE INVERTIR. Se marca DESPUÉS de que el proveedor
   * aceptó: si el mail falla, esa fila queda sin marcar y la vuelve a agarrar
   * la corrida siguiente. Marcando antes, un fallo del proveedor deja a
   * alguien sin recordatorio y con la marca puesta — y nadie se entera nunca.
   */
  it("al que le falló el mail NO lo marca", async () => {
    sendEmail
      .mockResolvedValueOnce(err(appError("email_send_failed", "no anduvo")))
      .mockResolvedValueOnce(ok("sent"));

    const summary = await sendDueReminders();

    expect(summary).toMatchObject({ due: 2, sent: 1, failed: 1 });
    expect(markCalls).toEqual(["b"]);
  });

  /**
   * Y EL FALLO DE UNO NO SE LLEVA EL LOTE. El caso de arriba ya lo prueba de
   * refilón; éste lo dice con volumen, que es donde importa: un proveedor que
   * rechaza una dirección inválida en el medio no puede dejar a los otros
   * treinta y nueve sin aviso.
   */
  it("un fallo en el medio no frena a los que siguen", async () => {
    dueRows = { data: ["a", "b", "c", "d"].map(row), error: null };
    sendEmail
      .mockResolvedValueOnce(ok("sent"))
      .mockResolvedValueOnce(err(appError("email_send_failed", "dirección inválida")))
      .mockResolvedValueOnce(ok("sent"))
      .mockResolvedValueOnce(ok("sent"));

    const summary = await sendDueReminders();

    expect(summary).toMatchObject({ due: 4, sent: 3, failed: 1 });
    expect(markCalls).toEqual(["a", "c", "d"]);
  });

  /**
   * CON LAS NOTIFICACIONES APAGADAS SE CORTA EN EL PRIMERO.
   *
   * No hay ninguna razón para recorrer cuatrocientos turnos preguntándole a un
   * módulo que ya dijo que no está configurado. Y sobre todo: NO se marca a
   * nadie. Marcar sin haber mandado dejaría a todos esos clientes sin
   * recordatorio para siempre, en silencio, el día que alguien prenda el
   * correo y crea que ya está andando.
   */
  it("apagado, no recorre el lote ni marca a nadie", async () => {
    sendEmail.mockResolvedValue(ok("not_configured"));

    const summary = await sendDueReminders();

    expect(summary).toMatchObject({ due: 2, sent: 0, notConfigured: true });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(markCalls).toEqual([]);
  });

  it("sin turnos que recordar no hace nada y lo dice", async () => {
    dueRows = { data: [], error: null };

    expect(await sendDueReminders()).toMatchObject({ due: 0, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("un error de la base vuelve como error, no como 'no había nadie'", async () => {
    dueRows = { data: null, error: { message: "boom" } };

    expect(await sendDueReminders()).toMatchObject({ failedToRead: true });
  });

  /**
   * EL CAMINO QUE TIRA. Del otro lado hay un endpoint HTTP: una excepción que
   * se escape es un 500, el cron lo reintenta, y el reintento vuelve a mandar
   * todo lo que ya había salido.
   */
  it("una excepción al crear el cliente no se escapa", async () => {
    clientFailure = new Error("falta la service-role key");

    await expect(sendDueReminders()).resolves.toMatchObject({ failedToRead: true });
  });
});
