import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import { createBusinessAction, updateBrandingAction } from "./actions";

/**
 * Tests de `createBusinessAction`: el onboarding crea el negocio vía la función
 * Postgres `create_business` y vuelve al panel. El redirect tiene que arrastrar
 * `?bienvenida=1`, porque el usuario sin negocio venía rebotado a
 * `/panel/bienvenida` y ese rebote perdió el parámetro que traía el alta.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

const rpc = vi.fn(async () => ({
  error: null as { message: string } | null,
}));

/**
 * Doble de `.from(...).update(...).eq(...)`. En el cliente real el `.eq()` final
 * es el terminal de un UPDATE: ahí es donde se resuelve la promesa.
 */
let updateError: { message: string } | null = null;
const eq = vi.fn(async () => ({ error: updateError }));
const update = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ update }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc, from }),
}));

const tenantStub = { id: "tenant-1", slug: "peluqueria-acme" };
const getCurrentTenant = vi.fn(async () => tenantStub as unknown);
vi.mock("./queries", () => ({
  getCurrentTenant: () => getCurrentTenant(),
}));

function createForm(businessName = "Peluquería Acme", country = "AR"): FormData {
  const form = new FormData();
  form.append("businessName", businessName);
  form.append("country", country);
  return form;
}

function brandForm(brandColor: string): FormData {
  const form = new FormData();
  form.append("brandColor", brandColor);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
  updateError = null;
  getCurrentTenant.mockResolvedValue(tenantStub);
});

describe("createBusinessAction", () => {
  it("redirige al panel con el disparador de bienvenida", async () => {
    await createBusinessAction(idleState, createForm());

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/panel?bienvenida=1");
  });

  it("si la RPC falla no revalida ni redirige", async () => {
    rpc.mockResolvedValue({ error: { message: "boom" } });

    const result = await createBusinessAction(idleState, createForm());

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});

/**
 * Tests de `updateBrandingAction`. Dos obsesiones acá:
 *
 * 1. Que un color inválido NO llegue a la base. El valor termina inyectado como
 *    valor CSS en la página pública del negocio, así que el rechazo tiene que
 *    ocurrir ANTES de escribir, no al pintarlo.
 * 2. Que se revalide la página PÚBLICA además del panel. Sin eso el dueño
 *    guarda, ve el cambio en su configuración, entra a su link y sigue viendo
 *    el color viejo — que es exactamente el único lugar donde el color importa.
 */
describe("updateBrandingAction", () => {
  it("guarda el color normalizado y revalida panel y página pública", async () => {
    const result = await updateBrandingAction(idleState, brandForm("#AABBCC"));

    expect(result.status).toBe("success");
    expect(from).toHaveBeenCalledWith("tenants");
    expect(update).toHaveBeenCalledWith({ brand_color: "#aabbcc" });
    expect(eq).toHaveBeenCalledWith("id", "tenant-1");
    expect(revalidatePath).toHaveBeenCalledWith("/panel/configuracion");
    expect(revalidatePath).toHaveBeenCalledWith("/peluqueria-acme");
  });

  // El caso que justifica la lista blanca del dominio: si esto escribiera, el
  // negocio podría reescribir el estilo de la página que ven sus clientes.
  it("no toca la base cuando el color trae CSS de contrabando", async () => {
    const result = await updateBrandingAction(
      idleState,
      brandForm("#6366f1;}html{display:none"),
    );

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("marca el campo cuando el color es inválido", async () => {
    const result = await updateBrandingAction(idleState, brandForm("rojo"));

    expect(result.status === "error" && result.fieldErrors?.brandColor).toBeTruthy();
  });

  it("no revalida si la escritura falla", async () => {
    updateError = { message: "boom" };

    const result = await updateBrandingAction(idleState, brandForm("#6366f1"));

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("falla sin tocar la base cuando el usuario no tiene negocio", async () => {
    getCurrentTenant.mockResolvedValue(null);

    const result = await updateBrandingAction(idleState, brandForm("#6366f1"));

    expect(result.status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });
});
