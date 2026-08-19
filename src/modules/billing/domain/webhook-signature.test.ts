import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { isValidWebhookSignature } from "./webhook-signature";

/**
 * Tests de la verificación de firma del webhook de Mercado Pago.
 *
 * Este es el único portón del proyecto que da a internet abierto: cualquiera
 * puede hacerle POST. Lo que decide si una notificación es de Mercado Pago o de
 * un desconocido es esta función y nada más, y lo que hay del otro lado es
 * activar suscripciones y rotar períodos de cobro.
 *
 * Por eso NO devuelve por qué falló: para quien llama hay una sola respuesta
 * útil —pasa o no pasa— y detallar el motivo le enseña a un atacante en qué
 * paso lo frenaron.
 *
 * El "ahora" se inyecta en TODOS los casos. Sin eso el test de una firma
 * legítima empieza a pasar o fallar según el día en que se corra la suite, que
 * es exactamente el defecto que tenía la primera versión de este archivo: la
 * constante de abajo quedó vieja y "acepta una firma legítima" seguía en verde,
 * demostrando sin querer que la firma no vencía nunca.
 */

const SECRET = "un-secreto-de-webhook-de-prueba";
const DATA_ID = "123456789";
const REQUEST_ID = "d2c4e3a1-0000-4444-8888-abcdefabcdef";

/** El `ts` del header, en segundos, y el mismo instante en milisegundos. */
const TS = "1755464280";
const SIGNED_AT_MS = 1_755_464_280_000;

const MINUTE = 60_000;
/** Espeja `MAX_SIGNATURE_AGE_MS` y `MAX_CLOCK_SKEW_MS` de la implementación. */
const WINDOW_MS = 5 * MINUTE;

/** Un minuto después de la firma: bien adentro de la ventana. */
const NOW = new Date(SIGNED_AT_MS + MINUTE);

/** Arma la firma que mandaría Mercado Pago para estas mismas entradas. */
function sign(
  { dataId = DATA_ID, requestId = REQUEST_ID, ts = TS, secret = SECRET } = {},
): string {
  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId.toLowerCase()}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);
  const manifest = `${parts.join(";")};`;

  const v1 = createHmac("sha256", secret).update(manifest).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

const valid = {
  signatureHeader: sign(),
  requestId: REQUEST_ID,
  dataId: DATA_ID,
  secret: SECRET,
  now: NOW,
};

describe("isValidWebhookSignature", () => {
  it("acepta una firma legítima y reciente", () => {
    expect(isValidWebhookSignature(valid)).toBe(true);
  });

  /**
   * EL CASO QUE JUSTIFICA TODO. Un secreto distinto tiene que dar `false`, o
   * sea que cualquiera que no tenga el secreto no puede activar suscripciones.
   */
  it("rechaza una firma hecha con otro secreto", () => {
    expect(
      isValidWebhookSignature({
        ...valid,
        signatureHeader: sign({ secret: "el-secreto-de-otro" }),
      }),
    ).toBe(false);
  });

  /**
   * El manifiesto ATA la firma a estos tres valores. Si alguno se pudiera
   * cambiar sin invalidarla, un atacante tomaría una notificación legítima
   * capturada y le cambiaría el `data.id` para activar OTRA suscripción — la
   * suya— con una firma que Mercado Pago emitió de verdad.
   */
  it.each([
    ["el id del recurso", { dataId: "999999999" }],
    ["el id de la request", { requestId: "00000000-1111-2222-3333-444444444444" }],
  ])("una firma válida para otros datos no sirve: cambiar %s", (_caso, cambio) => {
    expect(isValidWebhookSignature({ ...valid, ...cambio })).toBe(false);
  });

  /**
   * El `ts` viaja DOS veces: dentro del header y dentro del manifiesto firmado.
   * Si sólo se leyera el del header, moverlo no invalidaría nada. Este test
   * prueba que el que se firma es el mismo que se lee.
   */
  it("mover el ts del header invalida la firma", () => {
    const header = sign();
    const movido = header.replace(`ts=${TS}`, `ts=${Number(TS) + 1}`);

    expect(isValidWebhookSignature({ ...valid, signatureHeader: movido })).toBe(
      false,
    );
  });

  /**
   * `data.id` se normaliza a minúsculas antes de firmar, que es lo que hace
   * Mercado Pago. Sin eso, un id con mayúsculas produce un manifiesto distinto
   * del que ellos firmaron y toda notificación de ese recurso se rechaza.
   */
  it("el id del recurso se compara en minúsculas", () => {
    const enMayusculas = "ABC123DEF";

    expect(
      isValidWebhookSignature({
        ...valid,
        dataId: enMayusculas,
        signatureHeader: sign({ dataId: enMayusculas }),
      }),
    ).toBe(true);
  });

  /**
   * Las partes vacías se OMITEN del manifiesto, no se incluyen vacías. Un
   * `id:;request-id:abc;ts:1;` no es lo mismo que `request-id:abc;ts:1;` y
   * produce otro hash, así que estas notificaciones se rechazarían todas.
   */
  it.each([
    ["sin id de recurso", { dataId: null as string | null }],
    ["sin id de request", { requestId: null as string | null }],
  ])("%s se firma igual que Mercado Pago lo firma", (_caso, ausente) => {
    const dataId = "dataId" in ausente ? null : DATA_ID;
    const requestId = "requestId" in ausente ? null : REQUEST_ID;

    expect(
      isValidWebhookSignature({
        signatureHeader: sign({
          dataId: dataId ?? "",
          requestId: requestId ?? "",
        }),
        dataId,
        requestId,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  /**
   * FALLA CERRADO ante cualquier header que no se pueda leer. Ninguno de estos
   * es "casi válido": son todos "no probaste que seas Mercado Pago".
   */
  it.each([
    ["ausente", null],
    ["vacío", ""],
    ["sin v1", `ts=${TS}`],
    ["sin ts", "v1=abc123"],
    ["con basura", "esto no es una firma"],
    ["con v1 vacío", `ts=${TS},v1=`],
    ["con ts vacío", `ts=,v1=abc123`],
    ["sólo comas", ",,,"],
  ])("un header %s no pasa", (_caso, signatureHeader) => {
    expect(isValidWebhookSignature({ ...valid, signatureHeader })).toBe(false);
  });

  /**
   * EL QUE ROMPE EL ENDPOINT, no el que lo abre. `timingSafeEqual` de Node TIRA
   * un RangeError si los dos buffers tienen largos distintos — que es
   * exactamente lo que manda un atacante probando con `v1=x`. Sin igualar
   * largos antes, el endpoint devuelve 500 en vez de 401, y un 500 repetido es
   * una forma barata de tirar abajo el webhook de cobros.
   *
   * El ejemplo de la documentación de Mercado Pago tiene este bug tal cual.
   */
  it.each([
    ["muy corto", "x"],
    ["corto", "abc123"],
    ["más largo que un sha256", "a".repeat(128)],
    ["vacío entre comas", ""],
  ])("un v1 de largo %s devuelve false, no rompe", (_caso, v1) => {
    const header = `ts=${TS},v1=${v1}`;

    expect(() =>
      isValidWebhookSignature({ ...valid, signatureHeader: header }),
    ).not.toThrow();

    expect(isValidWebhookSignature({ ...valid, signatureHeader: header })).toBe(
      false,
    );
  });

  /**
   * Un `v1` del largo correcto pero que no es hexadecimal tampoco puede romper.
   * `Buffer.from(x, "hex")` no tira: descarta lo que no puede leer y devuelve
   * un buffer más corto, que es justo lo que vuelve a disparar el RangeError.
   */
  it("un v1 del largo correcto pero no hexadecimal devuelve false", () => {
    const header = `ts=${TS},v1=${"z".repeat(64)}`;

    expect(() =>
      isValidWebhookSignature({ ...valid, signatureHeader: header }),
    ).not.toThrow();

    expect(isValidWebhookSignature({ ...valid, signatureHeader: header })).toBe(
      false,
    );
  });

  /**
   * Un secreto vacío no puede dar por buena ninguna firma. Si el entorno quedó
   * sin configurar, el portón tiene que quedar CERRADO y no abierto de par en
   * par para cualquiera que sepa que el secreto es la cadena vacía.
   */
  it.each([
    ["vacío", ""],
    ["sólo espacios", "   "],
  ])("un secreto %s no valida nada", (_caso, secret) => {
    expect(
      isValidWebhookSignature({
        ...valid,
        secret,
        signatureHeader: sign({ secret }),
      }),
    ).toBe(false);
  });

  /**
   * El tipo dice `string`, pero el valor sale del entorno y un tipo no
   * sobrevive al límite del proceso: una variable sin definir llega como
   * `undefined` y `undefined.trim()` TIRA. Una excepción acá convierte un 401
   * en un 500 — la misma falla que el chequeo de largos evita del otro lado.
   */
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("un secreto %s devuelve false, no rompe", (_caso, secret) => {
    const entrada = { ...valid, secret: secret as unknown as string };

    expect(() => isValidWebhookSignature(entrada)).not.toThrow();
    expect(isValidWebhookSignature(entrada)).toBe(false);
  });

  /**
   * Se tolera lo que la documentación muestra como formato real: espacios
   * alrededor de las comas y de los iguales. Rechazar por un espacio haría que
   * el webhook falle por algo que Mercado Pago considera válido.
   */
  it.each([
    ["con espacios alrededor de la coma", (s: string) => s.replace(",", " , ")],
    ["con espacios alrededor del igual", (s: string) => s.replace("ts=", "ts = ")],
    ["con las claves al revés", (s: string) => s.split(",").reverse().join(",")],
  ])("un header %s se sigue leyendo", (_caso, deformar) => {
    expect(
      isValidWebhookSignature({ ...valid, signatureHeader: deformar(sign()) }),
    ).toBe(true);
  });

  /**
   * LA FIRMA VENCE, que es lo que la primera versión de este archivo no hacía.
   *
   * Incluir el `ts` en el manifiesto lo ATA a la firma —no se puede cambiar sin
   * invalidarla— pero eso no es lo mismo que exigir que sea reciente. Sin la
   * ventana, una notificación legítima capturada, sin tocarle un byte, sirve
   * para siempre: cualquiera que la haya visto pasar puede volver a dispararla
   * cuando quiera.
   */
  it("una firma de hace un año no sirve, por más que verifique", () => {
    const unAñoDespues = new Date(SIGNED_AT_MS + 365 * 24 * 60 * MINUTE);

    expect(isValidWebhookSignature({ ...valid, now: unAñoDespues })).toBe(false);
  });

  it("una firma de hace media hora tampoco sirve", () => {
    expect(
      isValidWebhookSignature({ ...valid, now: new Date(SIGNED_AT_MS + 30 * MINUTE) }),
    ).toBe(false);
  });

  /**
   * Los bordes EXACTOS de la ventana, por el mismo motivo que en `fx.ts`: sin
   * ellos, cambiar un `<=` por un `<` corre el rango real un milisegundo y no
   * rompe nada. Los casos de arriba están lejos del borde y no lo notarían.
   */
  it.each([
    ["justo en el límite de antigüedad", SIGNED_AT_MS + WINDOW_MS],
    ["justo en el límite de adelanto", SIGNED_AT_MS - WINDOW_MS],
  ])("una firma %s todavía sirve", (_caso, ahora) => {
    expect(isValidWebhookSignature({ ...valid, now: new Date(ahora) })).toBe(true);
  });

  it.each([
    ["un milisegundo más vieja", SIGNED_AT_MS + WINDOW_MS + 1],
    ["un milisegundo más adelantada", SIGNED_AT_MS - WINDOW_MS - 1],
  ])("una firma %s ya no sirve", (_caso, ahora) => {
    expect(isValidWebhookSignature({ ...valid, now: new Date(ahora) })).toBe(false);
  });

  /**
   * LA UNIDAD DEL `ts` ES AMBIGUA EN LA PROPIA DOCUMENTACIÓN: un lado dice
   * milisegundos, otro muestra diez dígitos, que son segundos. Interpretar mal
   * la unidad rompe la ventana entera — leer segundos como milisegundos hace
   * que toda firma parezca de 1970 y se rechace siempre.
   *
   * Se decide por magnitud, y las dos formas del MISMO instante tienen que
   * valer igual.
   */
  it("un ts en milisegundos vale igual que el mismo instante en segundos", () => {
    const tsMs = String(SIGNED_AT_MS);

    expect(
      isValidWebhookSignature({
        ...valid,
        signatureHeader: sign({ ts: tsMs }),
      }),
    ).toBe(true);
  });

  it("un ts en milisegundos también vence", () => {
    const tsMs = String(SIGNED_AT_MS);

    expect(
      isValidWebhookSignature({
        ...valid,
        signatureHeader: sign({ ts: tsMs }),
        now: new Date(SIGNED_AT_MS + 30 * MINUTE),
      }),
    ).toBe(false);
  });

  /**
   * Un `ts` que no es un entero positivo no es un momento. Se firman con ese
   * mismo `ts` a propósito: así el hash SÍ coincidiría, y lo único que puede
   * rechazarlos es el chequeo de frescura. Sin validar el formato, `Number()`
   * devuelve `NaN` y toda comparación con `NaN` da `false` — o sea que
   * "no está vencida" pasaría a ser verdad por accidente.
   */
  it.each([
    ["texto", "ayer"],
    ["mezcla", "1755464280abc"],
    ["negativo", "-1755464280"],
    ["decimal", "1755464280.5"],
    ["cero", "0"],
    ["con espacios adentro", "1755 464280"],
  ])("un ts %s no pasa la frescura", (_caso, ts) => {
    expect(
      isValidWebhookSignature({ ...valid, signatureHeader: sign({ ts }) }),
    ).toBe(false);
  });

  /**
   * SÓLO DÍGITOS, y estos dos son los que prueban que ese chequeo hace falta.
   *
   * Los dos textos de abajo son OTRAS ESCRITURAS del mismo instante fresco:
   * `Number("+1755464280")` y `Number("1.75546428e9")` dan exactamente el
   * mismo número, que es un entero seguro, positivo y dentro de la ventana. Sin
   * exigir sólo dígitos los dos pasarían — el chequeo de entero no los ve.
   *
   * Se rechazan porque Mercado Pago no manda el `ts` así, y aceptar varias
   * escrituras del mismo momento es una puerta de canonicalización que no hace
   * falta abrir. Sin estos dos casos el `/^\d+$/` es código muerto: se puede
   * borrar entero y la suite sigue en verde.
   */
  it.each([
    ["con un más adelante", "+1755464280"],
    ["en notación científica", "1.75546428e9"],
  ])("un ts %s no pasa, aunque apunte al mismo instante", (_caso, ts) => {
    expect(Number(ts)).toBe(SIGNED_AT_MS / 1000);

    expect(
      isValidWebhookSignature({ ...valid, signatureHeader: sign({ ts }) }),
    ).toBe(false);
  });
});
