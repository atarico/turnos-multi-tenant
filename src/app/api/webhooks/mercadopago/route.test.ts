import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

/**
 * Tests del único portón del proyecto abierto a internet.
 *
 * La firma NO se mockea: se arma de verdad con HMAC. Un mock probaría que
 * llamamos a la función, no que le pasamos los datos correctos — y ahí está el
 * bug caro. Pasarle el header equivocado, o leer `data.id` de donde no está,
 * hace que TODAS las notificaciones legítimas se rechacen, y eso sólo se
 * descubre cuando alguien paga y no se le activa.
 */

const SECRET = "secreto-del-webhook-de-prueba";

const apply = vi.fn();
let secret: string | undefined = SECRET;

vi.mock("@/lib/env", () => ({
  serverEnv: () => {
    // Espeja el comportamiento real: `serverEnv()` TIRA si falta una variable,
    // no devuelve undefined. Un mock que devolviera undefined escondería
    // justamente el camino que hay que probar.
    if (secret === undefined) throw new Error("Variables de entorno inválidas");
    return { MERCADOPAGO_WEBHOOK_SECRET: secret };
  },
}));

vi.mock("@/modules/billing/application/webhook", () => ({
  applyWebhookNotification: (...args: unknown[]) => apply(...args),
}));

const body = {
  type: "subscription_authorized_payment",
  action: "created",
  data: { id: "9876543210" },
};

const REQUEST_ID = "req-abc-123";

/** Arma el header `x-signature` como lo arma Mercado Pago. */
function sign(options: {
  dataId: string;
  ts: number;
  secret?: string;
  requestId?: string;
}): string {
  const requestId = options.requestId ?? REQUEST_ID;
  const manifest = `id:${options.dataId.toLowerCase()};request-id:${requestId};ts:${options.ts};`;
  const v1 = createHmac("sha256", options.secret ?? SECRET)
    .update(manifest)
    .digest("hex");

  return `ts=${options.ts},v1=${v1}`;
}

function request(options: {
  signature?: string | null;
  dataId?: string;
  requestId?: string;
  raw?: string;
} = {}): Request {
  const dataId = options.dataId ?? "9876543210";
  const headers = new Headers({ "content-type": "application/json" });

  if (options.signature !== null) {
    headers.set(
      "x-signature",
      options.signature ?? sign({ dataId, ts: Math.floor(Date.now() / 1000) }),
    );
  }
  headers.set("x-request-id", options.requestId ?? REQUEST_ID);

  return new Request(
    `https://app.turnos.com/api/webhooks/mercadopago?data.id=${dataId}&type=payment`,
    { method: "POST", headers, body: options.raw ?? JSON.stringify(body) },
  );
}

beforeEach(() => {
  apply.mockReset();
  apply.mockResolvedValue({ ok: true, value: "applied" });
  secret = SECRET;
});

describe("POST /api/webhooks/mercadopago", () => {
  it("acepta una notificación firmada y la aplica", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(apply).toHaveBeenCalledWith(body);
  });

  it("rechaza sin firma y NO toca nada", async () => {
    const response = await POST(request({ signature: null }));

    expect(response.status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rechaza una firma hecha con otro secreto", async () => {
    const response = await POST(
      request({
        signature: sign({
          dataId: "9876543210",
          ts: Math.floor(Date.now() / 1000),
          secret: "no-es-el-secreto",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rechaza una firma vencida aunque sea válida", async () => {
    // Una notificación legítima CAPTURADA. La firma verifica perfecto: lo
    // único que la frena es la ventana de frescura.
    const response = await POST(
      request({
        signature: sign({
          dataId: "9876543210",
          ts: Math.floor(Date.now() / 1000) - 3600,
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rechaza una firma reapuntada a otro recurso", async () => {
    // Firmada para el recurso 111 y mandada con `data.id=222`. El manifiesto
    // ata el id, así que el hash deja de dar.
    const response = await POST(
      request({
        dataId: "222",
        signature: sign({ dataId: "111", ts: Math.floor(Date.now() / 1000) }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("con el secreto sin configurar el portón queda CERRADO", async () => {
    // FALLA CERRADO. Sin esto, un deploy al que le falta la variable devuelve
    // 500 en vez de 401, y peor: si en vez de tirar devolviera undefined,
    // cualquiera podría activarse un plan.
    secret = undefined;

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("un cuerpo que no es JSON se acepta y no se aplica", async () => {
    // La firma ya validó, así que esto vino de Mercado Pago. Devolver 4xx lo
    // haría reintentar cada quince minutos para siempre algo que no mejora.
    const response = await POST(request({ raw: "no soy json" }));

    expect(response.status).toBe(200);
    expect(apply).not.toHaveBeenCalled();
  });

  it("pide reintento cuando no se pudo aplicar", async () => {
    // 5xx ES LA FORMA DE PEDIR EL REINTENTO. Un 200 acá le dice a Mercado Pago
    // que ya está resuelto y el cobro se pierde para siempre.
    apply.mockResolvedValue({
      ok: false,
      error: { code: "webhook_not_applied", message: "no se pudo" },
    });

    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it("pide reintento cuando todavía no conocemos la suscripción", async () => {
    // La carrera con el checkout. El reintento es lo que la arregla.
    apply.mockResolvedValue({
      ok: false,
      error: { code: "webhook_unknown_subscription", message: "no está" },
    });

    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it("pide reintento cuando Mercado Pago no contestó", async () => {
    apply.mockResolvedValue({
      ok: false,
      error: { code: "mp_unreachable", message: "no contestó" },
    });

    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it("NO pide reintento ante un contrato roto", async () => {
    // `mp_bad_response` no se arregla reintentando: contestaron 2xx con algo
    // inservible. Reintentarlo cada quince minutos para siempre es ruido.
    apply.mockResolvedValue({
      ok: false,
      error: { code: "mp_bad_response", message: "respuesta inservible" },
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
  });

  it("una excepción inesperada pide reintento en vez de escaparse", async () => {
    apply.mockRejectedValue(new Error("boom"));

    const response = await POST(request());
    expect(response.status).toBe(500);
  });

  it("ninguna respuesta filtra el secreto ni el detalle del error", async () => {
    apply.mockRejectedValue(new Error(`falló con ${SECRET}`));

    const response = await POST(request());
    const text = await response.text();

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("boom");
  });
});
