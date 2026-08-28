import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import { appError, err, ok } from "@/core/result";
import { throwingRedirectSpy } from "@/test-support/next-navigation";

import { startCheckoutAction } from "./actions";

/**
 * Tests de la Server Action del checkout.
 *
 * Una Server Action es alcanzable por POST directo, no sólo desde el botón:
 * quien la llame puede mandar cualquier `plan` y no mandar sesión. Lo que se
 * prueba acá es que nada de eso llegue a abrir un cobro.
 */

const redirect = throwingRedirectSpy();
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));

vi.mock("./checkout", () => ({ startCheckout: vi.fn() }));
vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.turnos.com" }),
}));

const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

const { startCheckout } = await import("./checkout");
const { getCurrentTenant } = await import("@/modules/tenants/application/queries");

const TENANT = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", slug: "mi-negocio" };
const INIT_POINT = "https://www.mercadopago.com.ar/subscriptions/checkout?id=2c93";

function form(plan: string): FormData {
  const data = new FormData();
  data.set("plan", plan);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentTenant).mockResolvedValue(TENANT as never);
  getUser.mockResolvedValue({ data: { user: { email: "duenio@negocio.com" } } });
  vi.mocked(startCheckout).mockResolvedValue(ok({ initPoint: INIT_POINT }));
});

describe("startCheckoutAction", () => {
  it("manda al pagador al checkout de la pasarela", async () => {
    await expect(startCheckoutAction(idleState, form("pro"))).rejects.toThrow(
      `NEXT_REDIRECT:${INIT_POINT}`,
    );
  });

  it("cobra el plan que vino en el formulario, para el negocio de la sesión", async () => {
    await startCheckoutAction(idleState, form("premium")).catch(() => {});

    expect(vi.mocked(startCheckout).mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT.id,
      plan: "premium",
      payerEmail: "duenio@negocio.com",
    });
  });

  /**
   * La vuelta se arma con la URL de la app y no con nada que venga del cliente.
   * Un `back_url` controlado por quien llama convierte a la pasarela en un
   * trampolín hacia cualquier sitio, con la confianza de nuestro dominio.
   */
  it("la vuelta apunta a nuestra app, no a algo del formulario", async () => {
    const data = form("pro");
    data.set("backUrl", "https://sitio-de-otro.com");

    await startCheckoutAction(idleState, data).catch(() => {});

    expect(vi.mocked(startCheckout).mock.calls[0]![0]!.backUrl).toBe(
      "https://app.turnos.com/panel/suscripcion",
    );
  });

  /**
   * `plan` viene del cliente. Un valor fuera del catálogo tiene que morir en la
   * validación y no llegar a `priceUsdCentsFor`, que rompe — un throw acá sería
   * un 500 en vez de un mensaje.
   */
  it.each([
    ["uno inventado", "enterprise"],
    ["una clave del prototipo", "toString"],
    ["vacío", ""],
    ["con otro formato", "PRO"],
  ])("un plan %s no abre ningún cobro", async (_caso, plan) => {
    const state = await startCheckoutAction(idleState, form(plan));

    expect(state.status).toBe("error");
    expect(vi.mocked(startCheckout)).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sin negocio en la sesión no se abre ningún cobro", async () => {
    vi.mocked(getCurrentTenant).mockResolvedValue(null);

    const state = await startCheckoutAction(idleState, form("pro"));

    expect(state.status).toBe("error");
    expect(vi.mocked(startCheckout)).not.toHaveBeenCalled();
  });

  /**
   * Sin mail no hay a quién cobrarle. Mercado Pago lo pide, y adivinarlo o
   * mandar uno vacío abriría una suscripción que nadie puede pagar.
   */
  it.each([
    ["no hay usuario", { data: { user: null } }],
    ["el usuario no tiene mail", { data: { user: { email: null } } }],
  ])("si %s no se abre ningún cobro", async (_caso, response) => {
    getUser.mockResolvedValue(response);

    const state = await startCheckoutAction(idleState, form("pro"));

    expect(state.status).toBe("error");
    expect(vi.mocked(startCheckout)).not.toHaveBeenCalled();
  });

  /**
   * Leer la sesión también puede TIRAR, no sólo devolver un usuario vacío:
   * falta de configuración, la red, un token que no se puede refrescar. Todo el
   * resto de esta action devuelve mensajes que se leen; sin este camino
   * atrapado, ese único caso devolvía una pantalla de error del framework.
   */
  it("si leer la cuenta TIRA, devuelve un mensaje y no una pantalla de error", async () => {
    getUser.mockRejectedValue(new Error("auth session missing"));

    const state = await startCheckoutAction(idleState, form("pro"));

    expect(state).toMatchObject({ status: "error" });
    expect(vi.mocked(startCheckout)).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  /**
   * El mensaje del error viaja tal cual a la pantalla, que es la convención del
   * repo (`booking-flow.tsx` lee `.error.message`). Reemplazarlo por uno
   * genérico perdería justo lo que distingue "probá de nuevo" de "escribinos
   * antes de reintentar" en el caso de la suscripción huérfana.
   */
  it("un fallo del checkout se muestra con su propio mensaje", async () => {
    vi.mocked(startCheckout).mockResolvedValue(
      err(appError("checkout_not_stamped", "Escribinos antes de volver a intentar.")),
    );

    const state = await startCheckoutAction(idleState, form("pro"));

    expect(state).toMatchObject({
      status: "error",
      message: "Escribinos antes de volver a intentar.",
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
