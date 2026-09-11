import { beforeEach, describe, expect, it, vi } from "vitest";

import { err, ok, appError } from "@/core/result";

/**
 * Tests del aviso de reserva creada.
 *
 * LA REGLA QUE ESTE ARCHIVO DEFIENDE, y es una sola: cuando esto corre, el
 * turno YA ESTÁ TOMADO y confirmado en la base. Nada de lo que pase acá puede
 * volver atrás, y nada de lo que pase acá puede tirar. Un proveedor caído, un
 * cliente sin mail, una tabla que no contesta — los tres terminan en un
 * desenlace que se puede leer, nunca en una excepción que suba hasta la cara
 * de alguien que reservó bien.
 *
 * DESDE ESTE PR el aviso tiene DOS PATAS independientes: al cliente y al
 * negocio. Son dos desenlaces por separado (`{ customer, tenant }`) y ni uno
 * puede tumbar al otro: un negocio sin nadie con mail no debe impedir que el
 * cliente reciba su confirmación, y un proveedor caído del lado del cliente no
 * debe impedir que se intente avisar al negocio.
 */

const sendEmail = vi.fn();
vi.mock("./email", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

let serviceRow: { data: unknown; error: unknown } = {
  data: { name: "Corte y barba" },
  error: null,
};
let staffRow: { data: unknown; error: unknown } = {
  data: { name: "Ana" },
  error: null,
};
/** Cuando está seteado, `createAdminClient` TIRA en vez de devolver cliente. */
let clientFailure: Error | null = null;
/** Lo que devuelve `tenant_notification_recipients` — un owner por defecto. */
let recipientsRow: { data: unknown; error: unknown } = {
  data: [{ email: "duena@negocio.com" }],
  error: null,
};
/** Cuando está seteado, la RPC de destinatarios TIRA en vez de devolver fila. */
let recipientsThrow: Error | null = null;
/** Los argumentos con los que se llamó la RPC de destinatarios. */
let lastRecipientsRpcArgs: unknown;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (clientFailure) throw clientFailure;
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => (table === "services" ? serviceRow : staffRow),
          }),
        }),
      }),
      rpc: async (fn: string, args?: unknown) => {
        if (fn !== "tenant_notification_recipients") return { data: null, error: null };
        lastRecipientsRpcArgs = args;
        if (recipientsThrow) throw recipientsThrow;
        return recipientsRow;
      },
    };
  },
}));

const { notifyBookingCreated } = await import("./notify-booking");

const input = {
  tenantId: "tenant-1",
  tenantName: "Peluquería Nube",
  timezone: "America/Argentina/Buenos_Aires",
  serviceId: "svc-1",
  staffId: "stf-1",
  startsAt: new Date("2026-09-15T13:30:00.000Z"),
  customerName: "Marcos",
  customerEmail: "marcos@correo.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  clientFailure = null;
  serviceRow = { data: { name: "Corte y barba" }, error: null };
  staffRow = { data: { name: "Ana" }, error: null };
  recipientsRow = { data: [{ email: "duena@negocio.com" }], error: null };
  recipientsThrow = null;
  lastRecipientsRpcArgs = undefined;
  sendEmail.mockResolvedValue(ok("sent"));
});

describe("notifyBookingCreated — la pata del cliente", () => {
  it("le manda la confirmación a quien reservó", async () => {
    const outcome = await notifyBookingCreated(input);

    expect(outcome.customer).toBe("sent");
    expect(sendEmail.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ to: "marcos@correo.com" }),
    );
  });

  it("el mail lleva el servicio y el profesional que buscó en la base", async () => {
    await notifyBookingCreated(input);

    const sentToCustomer = sendEmail.mock.calls
      .map((c) => c[0])
      .find((call) => call.to === "marcos@correo.com");
    expect(sentToCustomer.text).toContain("Corte y barba");
    expect(sentToCustomer.text).toContain("Ana");
  });

  /**
   * EL CASO MÁS FRECUENTE, y por eso el primero que no puede ser un error: el
   * mail es OPCIONAL en el formulario público. La mayoría de las reservas no
   * lo traen, y no hay nada roto en eso — simplemente no hay a dónde escribir.
   * Tratarlo como fallo llenaría los logs de ruido y taparía los reales.
   */
  it("sin mail del cliente no intenta nada de ese lado y lo dice", async () => {
    const outcome = await notifyBookingCreated({ ...input, customerEmail: null });

    expect(outcome.customer).toBe("no_email");
    expect(sendEmail.mock.calls.map((c) => c[0])).not.toContainEqual(
      expect.objectContaining({ to: expect.stringContaining("marcos") }),
    );
  });

  it("con las notificaciones apagadas lo reporta como apagado, no como fallo", async () => {
    sendEmail.mockResolvedValue(ok("not_configured"));

    expect((await notifyBookingCreated(input)).customer).toBe("not_configured");
  });

  it("un fallo del proveedor vuelve como fallo, sin tirar", async () => {
    sendEmail.mockResolvedValue(err(appError("email_send_failed", "no anduvo")));

    expect((await notifyBookingCreated(input)).customer).toBe("failed");
  });

  /**
   * SIN PROFESIONAL, EL MAIL SALE IGUAL.
   *
   * La reserva permite no asignar profesional, y además la lectura puede no
   * encontrarlo. Ninguna de las dos cosas justifica dejar al cliente sin
   * confirmación: el turno existe, la hora existe, y eso es lo que necesita.
   * Se manda con lo que hay.
   */
  it("si no encuentra al profesional manda igual, sin esa línea", async () => {
    staffRow = { data: null, error: null };

    const outcome = await notifyBookingCreated(input);

    expect(outcome.customer).toBe("sent");
    const sentToCustomer = sendEmail.mock.calls
      .map((c) => c[0])
      .find((call) => call.to === "marcos@correo.com");
    expect(sentToCustomer.text).not.toContain("undefined");
  });

  /**
   * Pero SIN SERVICIO no: el servicio es el "qué" del turno, y un mail que
   * confirma algo sin decir qué es peor que no mandarlo. Ahí sí se corta —
   * PARA LAS DOS PATAS, porque ninguna plantilla puede armarse sin ese dato.
   */
  it("si no encuentra el servicio no manda un mail a medias, ni al cliente ni al negocio", async () => {
    serviceRow = { data: null, error: null };

    const outcome = await notifyBookingCreated(input);

    expect(outcome).toEqual({ customer: "failed", tenant: "failed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  /** SIN MAIL DEL CLIENTE, `no_email` SIEMPRE — aunque el servicio no se
   * encuentre: no había a dónde escribirle igual. */
  it("sin mail del cliente es 'no_email' aunque el servicio no se encuentre", async () => {
    serviceRow = { data: null, error: null };

    const outcome = await notifyBookingCreated({ ...input, customerEmail: null });

    expect(outcome).toEqual({ customer: "no_email", tenant: "failed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  /**
   * EL CAMINO QUE TIRA. `createAdminClient()` revienta si falta la
   * service-role key. Si se escapa, una reserva perfectamente buena termina en
   * un crash del framework — el error que este módulo entero existe para
   * evitar. Mismo aprendizaje que ya está escrito en `checkout.ts` y
   * `cancel.ts`.
   */
  it("una excepción al leer la base no se escapa, y tumba las dos patas", async () => {
    clientFailure = new Error("falta la service-role key");

    await expect(notifyBookingCreated(input)).resolves.toEqual({
      customer: "failed",
      tenant: "failed",
    });
  });
});

/**
 * Tests de la pata del NEGOCIO — la que agrega este PR.
 *
 * Hasta ahora el dueño no se enteraba de una reserva nueva salvo que abriera
 * el panel. Lo que se cuida acá es que el aviso sea INDEPENDIENTE del que
 * recibe el cliente: uno no puede tumbar al otro.
 */
describe("notifyBookingCreated — la pata del negocio", () => {
  it("le avisa a los owner/admin que devuelve la función de la base", async () => {
    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("sent");
    expect(sendEmail.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ to: "duena@negocio.com" }),
    );
  });

  /** LA RPC TIENE QUE PREGUNTAR POR EL TENANT CORRECTO, no por cualquier cosa. */
  it("le pide los destinatarios a la base con el tenant de la reserva", async () => {
    await notifyBookingCreated(input);

    expect(lastRecipientsRpcArgs).toEqual({ p_tenant_id: input.tenantId });
  });

  /** LA RPC PUEDE TIRAR, no sólo devolver un `error` — es la forma realista
   * de un timeout o un corte de transporte. */
  it("si la RPC de destinatarios tira, el negocio queda en failed sin afectar al cliente", async () => {
    recipientsThrow = new Error("timeout");

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("failed");
    expect(outcome.customer).toBe("sent");
  });

  it("el mail al negocio lleva el servicio, el profesional y quién reservó", async () => {
    await notifyBookingCreated(input);

    const sentToTenant = sendEmail.mock.calls
      .map((c) => c[0])
      .find((call) => call.to === "duena@negocio.com");
    expect(sentToTenant.text).toContain("Corte y barba");
    expect(sentToTenant.text).toContain("Ana");
    expect(sentToTenant.text).toContain("Marcos");
  });

  /**
   * Sin nadie a quién avisarle del lado del negocio, `no_email` es el
   * desenlace correcto — es EL MISMO significado que ya tiene ese valor para
   * el cliente: "no hay a dónde escribir", no un fallo.
   */
  it("sin owner/admin con mail no intenta nada de ese lado y lo dice", async () => {
    recipientsRow = { data: [], error: null };

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("no_email");
  });

  it("si falla la consulta de destinatarios, el negocio queda en failed sin afectar al cliente", async () => {
    recipientsRow = { data: null, error: appError("db_error", "no contestó") };

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("failed");
    expect(outcome.customer).toBe("sent");
  });

  /**
   * UN PROVEEDOR CAÍDO DEL LADO DEL CLIENTE NO CONTAMINA AL NEGOCIO, y al
   * revés. Son dos envíos independientes: que uno falle no dice nada del otro.
   */
  it("un fallo al mandarle al cliente no afecta el aviso al negocio", async () => {
    sendEmail.mockImplementation(async (email: { to: string }) =>
      email.to === "marcos@correo.com"
        ? err(appError("email_send_failed", "no anduvo"))
        : ok("sent"),
    );

    const outcome = await notifyBookingCreated(input);

    expect(outcome.customer).toBe("failed");
    expect(outcome.tenant).toBe("sent");
  });

  /**
   * MÚLTIPLES DESTINATARIOS: se le avisa a TODOS los owner/admin que
   * devuelve la base, no sólo al primero.
   *
   * DECISIÓN DE AGREGADO (no estaba especificada, la tomo acá): con varios
   * destinatarios puede pasar que unos reciban el mail y otros no —un
   * proveedor no rebota igual para toda una lista—. `sent` gana si AL MENOS
   * UNO salió: el negocio se entera igual, aunque sea por una sola bandeja. El
   * long tail es `failed` si TODOS los intentos fallan, porque ahí no llegó a
   * nadie.
   */
  it("con varios destinatarios, alcanza con que uno reciba el mail para que sea 'sent'", async () => {
    recipientsRow = {
      data: [{ email: "duena@negocio.com" }, { email: "socio@negocio.com" }],
      error: null,
    };
    sendEmail.mockImplementation(async (email: { to: string }) =>
      email.to === "duena@negocio.com"
        ? ok("sent")
        : err(appError("email_send_failed", "rebotó")),
    );

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("sent");
  });

  it("si TODOS los intentos fallan, el agregado es 'failed'", async () => {
    recipientsRow = {
      data: [{ email: "duena@negocio.com" }, { email: "socio@negocio.com" }],
      error: null,
    };
    sendEmail.mockResolvedValue(err(appError("email_send_failed", "rebotó")));

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("failed");
  });

  /**
   * Con el correo apagado, TODOS los intentos vuelven `not_configured` —es un
   * estado global, no por destinatario— y el agregado tiene que decir lo
   * mismo, no confundirlo con un fallo.
   */
  it("con las notificaciones apagadas, el agregado es 'not_configured' y no 'failed'", async () => {
    recipientsRow = {
      data: [{ email: "duena@negocio.com" }, { email: "socio@negocio.com" }],
      error: null,
    };
    sendEmail.mockResolvedValue(ok("not_configured"));

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("not_configured");
  });

  /** "NUNCA TIRA" vale también cuando `sendEmail` RECHAZA la promesa, no
   * sólo cuando devuelve un `Result` de error. */
  it("un sendEmail que TIRA para el cliente no se escapa y no impide el aviso al negocio", async () => {
    sendEmail.mockImplementation(async (email: { to: string }) =>
      email.to === "marcos@correo.com"
        ? Promise.reject(new Error("timeout"))
        : ok("sent"),
    );

    await expect(notifyBookingCreated(input)).resolves.toEqual({
      customer: "failed",
      tenant: "sent",
    });
  });

  /** Y con varios destinatarios, que uno TIRE no descarta a los que sí salieron. */
  it("un sendEmail que TIRA para un destinatario del negocio no descarta a los demás", async () => {
    recipientsRow = {
      data: [{ email: "duena@negocio.com" }, { email: "socio@negocio.com" }],
      error: null,
    };
    sendEmail.mockImplementation(async (email: { to: string }) =>
      email.to === "duena@negocio.com"
        ? Promise.reject(new Error("timeout"))
        : ok("sent"),
    );

    const outcome = await notifyBookingCreated(input);

    expect(outcome.tenant).toBe("sent");
  });
});
