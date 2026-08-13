import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import { createBusinessAction } from "./actions";

/**
 * Tests de `createBusinessAction`: el onboarding crea el negocio vía la función
 * Postgres `create_business` y vuelve al panel. El redirect tiene que arrastrar
 * `?bienvenida=1`, porque el panel consumió ese parámetro mientras el usuario
 * todavía no tenía negocio y el modal de bienvenida nunca llegó a mostrarse.
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
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));

function createForm(businessName = "Peluquería Acme", country = "AR"): FormData {
  const form = new FormData();
  form.append("businessName", businessName);
  form.append("country", country);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
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
