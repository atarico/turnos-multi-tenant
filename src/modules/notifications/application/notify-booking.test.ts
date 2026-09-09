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
    };
  },
}));

const { notifyBookingCreated } = await import("./notify-booking");

const input = {
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
  sendEmail.mockResolvedValue(ok("sent"));
});

describe("notifyBookingCreated", () => {
  it("le manda la confirmación a quien reservó", async () => {
    const outcome = await notifyBookingCreated(input);

    expect(outcome).toBe("sent");
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: "marcos@correo.com" });
  });

  it("el mail lleva el servicio y el profesional que buscó en la base", async () => {
    await notifyBookingCreated(input);

    const sent = sendEmail.mock.calls[0]![0];
    expect(sent.text).toContain("Corte y barba");
    expect(sent.text).toContain("Ana");
  });

  /**
   * EL CASO MÁS FRECUENTE, y por eso el primero que no puede ser un error: el
   * mail es OPCIONAL en el formulario público. La mayoría de las reservas no
   * lo traen, y no hay nada roto en eso — simplemente no hay a dónde escribir.
   * Tratarlo como fallo llenaría los logs de ruido y taparía los reales.
   */
  it("sin mail del cliente no intenta nada y lo dice", async () => {
    const outcome = await notifyBookingCreated({ ...input, customerEmail: null });

    expect(outcome).toBe("no_email");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("con las notificaciones apagadas lo reporta como apagado, no como fallo", async () => {
    sendEmail.mockResolvedValue(ok("not_configured"));

    expect(await notifyBookingCreated(input)).toBe("not_configured");
  });

  it("un fallo del proveedor vuelve como fallo, sin tirar", async () => {
    sendEmail.mockResolvedValue(err(appError("email_send_failed", "no anduvo")));

    expect(await notifyBookingCreated(input)).toBe("failed");
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

    expect(outcome).toBe("sent");
    expect(sendEmail.mock.calls[0]![0].text).not.toContain("undefined");
  });

  /**
   * Pero SIN SERVICIO no: el servicio es el "qué" del turno, y un mail que
   * confirma algo sin decir qué es peor que no mandarlo. Ahí sí se corta, y
   * se corta con un desenlace legible.
   */
  it("si no encuentra el servicio no manda un mail a medias", async () => {
    serviceRow = { data: null, error: null };

    const outcome = await notifyBookingCreated(input);

    expect(outcome).toBe("failed");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  /**
   * EL CAMINO QUE TIRA. `createAdminClient()` revienta si falta la
   * service-role key. Si se escapa, una reserva perfectamente buena termina en
   * un crash del framework — el error que este módulo entero existe para
   * evitar. Mismo aprendizaje que ya está escrito en `checkout.ts` y
   * `cancel.ts`.
   */
  it("una excepción al leer la base no se escapa", async () => {
    clientFailure = new Error("falta la service-role key");

    await expect(notifyBookingCreated(input)).resolves.toBe("failed");
  });
});
