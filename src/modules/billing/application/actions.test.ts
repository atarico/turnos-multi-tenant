import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";
import { appError, err, ok } from "@/core/result";
import { throwingRedirectSpy } from "@/test-support/next-navigation";

import { cancelSubscriptionAction, startCheckoutAction } from "./actions";

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
vi.mock("./cancel", () => ({ cancelSubscription: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
const { cancelSubscription } = await import("./cancel");
const { revalidatePath } = await import("next/cache");
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

/**
 * Tests de la Server Action de la baja.
 *
 * Lo que se cuida es que el negocio salga SIEMPRE de la sesión y nunca del
 * formulario. Esta action es alcanzable por POST directo: si aceptara un
 * `tenant_id` de afuera, cualquiera con una cuenta daría de baja el negocio de
 * otro, y del lado SQL no hay red de contención — `cancel_subscription()` mira
 * el parámetro que le pasan, por eso está grantada sólo a `service_role`.
 */
describe("cancelSubscriptionAction", () => {
  beforeEach(() => {
    vi.mocked(getCurrentTenant).mockResolvedValue(TENANT as never);
    vi.mocked(cancelSubscription).mockResolvedValue(ok("canceled"));
  });

  it("da de baja la suscripción del negocio de la sesión", async () => {
    await cancelSubscriptionAction(idleState, new FormData());

    expect(cancelSubscription).toHaveBeenCalledWith(TENANT.id);
  });

  /**
   * EL TEST QUE IMPORTA. Un `tenant_id` en el formulario se ignora: el negocio
   * sale de la sesión y de ningún otro lado.
   */
  it("ignora el negocio que venga en el formulario", async () => {
    const data = new FormData();
    data.set("tenant_id", "11111111-1111-1111-1111-111111111111");

    await cancelSubscriptionAction(idleState, data);

    expect(cancelSubscription).toHaveBeenCalledWith(TENANT.id);
  });

  it("sin negocio no da de baja nada", async () => {
    vi.mocked(getCurrentTenant).mockResolvedValue(null);

    const state = await cancelSubscriptionAction(idleState, new FormData());

    expect(state.status).toBe("error");
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("avisa que quedó dada de baja", async () => {
    const state = await cancelSubscriptionAction(idleState, new FormData());

    expect(state.status).toBe("success");
  });

  /**
   * Una segunda baja es éxito y no error: el botón se aprieta dos veces, o el
   * webhook se adelantó. Decirle que falló lo manda a reintentar algo hecho.
   */
  it("una segunda baja también es éxito", async () => {
    vi.mocked(cancelSubscription).mockResolvedValue(ok("already_canceled"));

    const state = await cancelSubscriptionAction(idleState, new FormData());

    expect(state.status).toBe("success");
  });

  /**
   * El mensaje viaja TAL CUAL, que es la convención del repo. Reemplazarlo por
   * uno genérico perdería justo lo que distingue "no se te va a cobrar más
   * pero no lo registramos" de "no se pudo dar de baja" — dos situaciones que
   * piden cosas distintas del dueño.
   */
  it("deja pasar el mensaje del error sin reescribirlo", async () => {
    vi.mocked(cancelSubscription).mockResolvedValue(
      err(appError("cancel_not_recorded", "no se te va a cobrar más, pero...")),
    );

    const state = await cancelSubscriptionAction(idleState, new FormData());

    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.message).toBe("no se te va a cobrar más, pero...");
    }
  });

  /** La pantalla tiene que reflejar la baja sin que el dueño recargue. */
  it("revalida la pantalla de suscripción", async () => {
    await cancelSubscriptionAction(idleState, new FormData());

    expect(revalidatePath).toHaveBeenCalledWith("/panel/suscripcion");
  });
});
