import { describe, expect, it } from "vitest";

import { buildBookingConfirmation, type BookingEmailData } from "./booking-email";

/**
 * Tests del contenido del mail de confirmación.
 *
 * Es lo ÚNICO que le queda al cliente después de reservar: hasta hoy cerraba
 * la pestaña y no le quedaba nada. Así que lo que se cuida acá no es el
 * formato sino que los cuatro datos que necesita para presentarse el día del
 * turno estén sí o sí —qué, con quién, cuándo y dónde— y que la hora sea la
 * del NEGOCIO, que es donde va a ir.
 *
 * Y una obsesión más: que no prometa nada que el producto no hace.
 */

const data: BookingEmailData = {
  tenantName: "Peluquería Nube",
  serviceName: "Corte y barba",
  staffName: "Ana",
  startsAt: new Date("2026-09-15T13:30:00.000Z"),
  timezone: "America/Argentina/Buenos_Aires",
  customerName: "Marcos",
};

describe("buildBookingConfirmation", () => {
  it("dice el negocio en el asunto, que es lo que se lee sin abrir", () => {
    const mail = buildBookingConfirmation(data);

    expect(mail.subject).toContain("Peluquería Nube");
  });

  /**
   * LA HORA EN LA ZONA DEL NEGOCIO, no en la del servidor.
   *
   * 13:30 UTC son las 10:30 en Buenos Aires. El servidor corre en UTC, así que
   * un mail que no convierta manda al cliente tres horas tarde — y en el borde
   * del día, directamente otro día. Es el mismo cuidado que ya tiene la
   * pantalla de suscripción con las fechas de cobro, y acá pesa más: de esto
   * depende que la persona se presente.
   */
  it("pone la hora en la zona del negocio", () => {
    const mail = buildBookingConfirmation(data);

    expect(mail.text).toContain("10:30");
    expect(mail.text).not.toContain("13:30");
  });

  it("y la fecha completa, en palabras, no en números sueltos", () => {
    const mail = buildBookingConfirmation(data);

    // "martes 15 de septiembre" — el día de la semana entra porque es lo que
    // una persona usa para ubicarse, más que el número.
    expect(mail.text).toContain("15 de septiembre");
    expect(mail.text).toContain("martes");
  });

  it("dice qué se reservó y con quién", () => {
    const mail = buildBookingConfirmation(data);

    expect(mail.text).toContain("Corte y barba");
    expect(mail.text).toContain("Ana");
  });

  it("saluda por el nombre de quien reservó", () => {
    const mail = buildBookingConfirmation(data);

    expect(mail.text).toContain("Marcos");
  });

  /**
   * NO PROMETE UN BOTÓN QUE NO EXISTE.
   *
   * El cliente no tiene forma de cancelar ni reprogramar solo: no hay pantalla
   * pública para eso, y construirla es otra cosa. Un mail que diga "cancelá
   * desde acá" manda a alguien a buscar un link que no está, y termina en el
   * negocio atendiendo un reclamo. Se le dice la verdad: que escriba.
   */
  it("no ofrece cancelar ni reprogramar desde el mail", () => {
    const mail = buildBookingConfirmation(data);

    expect(mail.text.toLowerCase()).not.toMatch(/cancelá (acá|aquí|desde)/);
    expect(mail.text.toLowerCase()).toContain("escribile");
  });

  /**
   * El HTML y el texto plano dicen LO MISMO. No es cosmético: muchos clientes
   * de correo —y casi todos los filtros de spam— leen la parte de texto, y una
   * versión que diga menos que la otra es una trampa para el que la reciba
   * recortada.
   */
  it("la versión HTML lleva los mismos datos que la de texto", () => {
    const mail = buildBookingConfirmation(data);

    for (const dato of ["Peluquería Nube", "Corte y barba", "Ana", "10:30"]) {
      expect(mail.html).toContain(dato);
    }
  });

  /**
   * El profesional puede no estar asignado —la reserva lo permite— y ahí el
   * mail no puede decir "con null". Se cae con elegancia: se omite la línea.
   */
  it("sin profesional asignado, omite esa línea en vez de mostrar un hueco", () => {
    const mail = buildBookingConfirmation({ ...data, staffName: null });

    expect(mail.text).not.toContain("null");
    expect(mail.text).not.toContain("undefined");
    expect(mail.text).toContain("Corte y barba");
  });
});
