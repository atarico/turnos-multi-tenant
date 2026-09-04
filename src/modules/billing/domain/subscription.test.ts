import { describe, expect, it } from "vitest";

import { isInTrial, takesNewBookings, trialDaysLeft } from "./subscription";

/**
 * La prueba gratis se maneja con una fecha en la suscripción, sin tarjeta y
 * sin tocar la pasarela. Pedir tarjeta de entrada mata la conversión en este
 * segmento, y meter el trial dentro del cobro recurrente complica la
 * integración para nada.
 *
 * Todo acá recibe el `now` como parámetro. Leer el reloj adentro haría que
 * estos tests fallaran solos algún martes a la medianoche.
 */

const NOW = new Date("2026-08-17T12:00:00Z");

/** Un instante a `days` días de `NOW`. Negativo = pasado. */
function daysFromNow(days: number): Date {
  const date = new Date(NOW);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/**
 * Una suscripción en prueba que vence dentro de `days` días.
 *
 * `currentPeriodEnd` sale con la MISMA fecha que `trialEndsAt`, y no es para
 * llenar el campo: es lo que hace `create_business`, que abre la fila con
 * `current_period_end = trial_ends_at`. La prueba ES el período pago, y de esa
 * equivalencia depende que darse de baja durante la prueba deje terminarla sin
 * un caso especial.
 */
function trialEndingIn(days: number) {
  const trialEndsAt = daysFromNow(days);
  return {
    status: "trialing" as const,
    trialEndsAt,
    currentPeriodEnd: trialEndsAt,
  };
}

/** Una baja cuyo período pago termina en `days` días. Negativo = ya venció. */
function canceledWithPeriodEndingIn(days: number) {
  return {
    status: "canceled" as const,
    trialEndsAt: null,
    currentPeriodEnd: daysFromNow(days),
  };
}

describe("isInTrial", () => {
  it("está en prueba mientras el estado es trialing y no venció", () => {
    expect(isInTrial(trialEndingIn(5), NOW)).toBe(true);
  });

  /**
   * El estado lo mueve el cobro, no el reloj: entre que vence la prueba y
   * llega el webhook hay una ventana donde el estado todavía dice `trialing`
   * pero la fecha ya pasó. Mandan los hechos, no la etiqueta.
   */
  it("deja de estar en prueba cuando la fecha ya pasó, aunque el estado no se haya movido", () => {
    expect(isInTrial(trialEndingIn(-1), NOW)).toBe(false);
  });

  // Justo en el instante del vencimiento la prueba ya terminó.
  it("no está en prueba justo al vencer", () => {
    expect(isInTrial({ status: "trialing", trialEndsAt: NOW }, NOW)).toBe(false);
  });

  it("una suscripción paga no está en prueba aunque le quede fecha", () => {
    expect(
      isInTrial({ status: "active", trialEndsAt: trialEndingIn(5).trialEndsAt }, NOW),
    ).toBe(false);
  });

  it("sin fecha de prueba no hay prueba", () => {
    expect(isInTrial({ status: "trialing", trialEndsAt: null }, NOW)).toBe(false);
  });
});

describe("trialDaysLeft", () => {
  it("cuenta los días que faltan", () => {
    expect(trialDaysLeft(trialEndingIn(5), NOW)).toBe(5);
  });

  /**
   * Redondea PARA ARRIBA: a alguien que le quedan 18 horas le queda "1 día",
   * no cero. Mostrar cero mientras el servicio todavía anda es mentirle.
   */
  it("una fracción de día cuenta como un día", () => {
    const trialEndsAt = new Date("2026-08-18T06:00:00Z"); // 18 horas

    expect(trialDaysLeft({ status: "trialing", trialEndsAt }, NOW)).toBe(1);
  });

  it("vencida no quedan días", () => {
    expect(trialDaysLeft(trialEndingIn(-3), NOW)).toBe(0);
  });

  it("sin prueba no quedan días", () => {
    expect(trialDaysLeft({ status: "active", trialEndsAt: null }, NOW)).toBe(0);
  });
});

/**
 * `takesNewBookings` ESPEJA a `public.tenant_takes_bookings()`, en
 * `20260904120001_cancel_subscription.sql` (que reescribió la de
 * `20260903120001`). Las dos existen a
 * propósito y responden lo mismo por razones distintas: la de la base es la
 * que FRENA —adentro de `create_booking()`, donde ni un dueño pegándole a
 * PostgREST directo la puede saltear—, y esta es la que AVISA, para que el
 * panel y la página pública no muestren un formulario que la base va a
 * rechazar. Si una cambia sin la otra, el usuario llena el formulario y recién
 * ahí se entera. Cualquier caso que se agregue acá va también al test SQL
 * `supabase/tests/cancel_subscription.sql`.
 */
describe("takesNewBookings", () => {
  it("durante la prueba sí toma turnos", () => {
    expect(takesNewBookings(trialEndingIn(5), NOW)).toBe(true);
  });

  /**
   * EL caso que motivó todo esto: nada mueve el estado de `trialing` cuando se
   * cumple la fecha —no hay cron, no hay trigger, el webhook sólo se despierta
   * si alguien paga—, así que una prueba vencida se queda en `trialing` para
   * siempre. Mirar sólo el estado es dejar el producto gratis.
   */
  it("con la prueba vencida NO toma turnos, aunque el estado siga en trialing", () => {
    expect(takesNewBookings(trialEndingIn(-1), NOW)).toBe(false);
  });

  it("no toma turnos justo en el instante en que vence la prueba", () => {
    expect(
      takesNewBookings(
        { status: "trialing", trialEndsAt: NOW, currentPeriodEnd: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  it("una prueba sin fecha de vencimiento no habilita nada", () => {
    expect(
      takesNewBookings(
        { status: "trialing", trialEndsAt: null, currentPeriodEnd: daysFromNow(5) },
        NOW,
      ),
    ).toBe(false);
  });

  it("una suscripción paga toma turnos", () => {
    expect(
      takesNewBookings(
        { status: "active", trialEndsAt: null, currentPeriodEnd: daysFromNow(25) },
        NOW,
      ),
    ).toBe(true);
  });

  /**
   * `past_due` sigue tomando turnos y no es un descuido: el cobro falló pero
   * Mercado Pago todavía lo está reintentando. Cortarle la agenda a un negocio
   * que está atendiendo gente por una tarjeta vencida es exactamente lo que no
   * queremos hacer. Es la misma decisión que ya toma `LIVE_STATUSES`.
   */
  it("un cobro atrasado sigue tomando turnos durante la gracia", () => {
    expect(
      takesNewBookings(
        { status: "past_due", trialEndsAt: null, currentPeriodEnd: daysFromNow(-1) },
        NOW,
      ),
    ).toBe(true);
  });

  /**
   * LA BAJA CORTA EL COBRO, NO EL SERVICIO. Quien pagó hasta fin de mes y se
   * da de baja hoy sigue tomando turnos hasta que ese período termine:
   * cobrarle el mes y sacárselo el día que avisa que se va es quedarse con
   * plata por un servicio que no se prestó.
   */
  it("una baja con el período pago todavía corriendo sigue tomando turnos", () => {
    expect(takesNewBookings(canceledWithPeriodEndingIn(25), NOW)).toBe(true);
  });

  /**
   * Y el espejo, que es lo que hace que la regla de arriba no sea un regalo
   * eterno: vencido el período, se congela solo. Nada tiene que correr — la
   * fila se queda como está y la comparación con `now()` deja de dar true.
   */
  it("una baja con el período ya vencido no toma turnos", () => {
    expect(takesNewBookings(canceledWithPeriodEndingIn(-1), NOW)).toBe(false);
  });

  it("no toma turnos justo en el instante en que termina el período de una baja", () => {
    expect(
      takesNewBookings(
        { status: "canceled", trialEndsAt: null, currentPeriodEnd: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  /**
   * Y la fecha de prueba NO revive a una baja cuyo período ya pasó. Es el
   * estado de quien canceló el mismo día que se dio de alta y volvió meses
   * después: `trial_ends_at` quedó en el futuro respecto de su alta, pero lo
   * que manda es hasta cuándo está pago.
   */
  it("una baja con el período vencido no revive por una fecha de prueba futura", () => {
    expect(
      takesNewBookings(
        {
          status: "canceled",
          trialEndsAt: daysFromNow(5),
          currentPeriodEnd: daysFromNow(-1),
        },
        NOW,
      ),
    ).toBe(false);
  });

  /**
   * Sin suscripción no se toman turnos. No es un caso teórico ni un negocio
   * "recién creado": `create_business` abre la suscripción en la MISMA
   * transacción que el negocio, y `20260817120002` le dio una a cada negocio
   * que ya existía. Un negocio sin suscripción es un estado roto, y ante un
   * estado roto el default seguro es no dejar entrar trabajo nuevo.
   */
  it("sin suscripción no toma turnos", () => {
    expect(takesNewBookings(null, NOW)).toBe(false);
  });
});
