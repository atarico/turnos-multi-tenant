import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import { signUpAction } from "./actions";

/**
 * Tests de `signUpAction`: el registro crea SOLO la cuenta. El negocio lo crea
 * siempre el onboarding del panel, con sesión o sin ella, así que la action
 * nunca toca la RPC `create_business` ni pide nombre de negocio o país.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

vi.mock("@/lib/supabase/config", () => ({
  isSupabaseConfigured: () => true,
}));

const signUp = vi.fn(async () => ({
  data: { session: null as unknown },
  error: null as { message: string } | null,
}));
const rpc = vi.fn(async () => ({ error: null as { message: string } | null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signUp }, rpc }),
}));

function registerForm(
  fields: Partial<Record<"fullName" | "email" | "password", string>> = {},
): FormData {
  const form = new FormData();
  form.append("fullName", fields.fullName ?? "Martina Ríos");
  form.append("email", fields.email ?? "martina@negocio.com");
  form.append("password", fields.password ?? "unaClaveLarga");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  signUp.mockResolvedValue({ data: { session: null }, error: null });
  rpc.mockResolvedValue({ error: null });
});

describe("signUpAction", () => {
  it("con sesión manda al panel y no crea el negocio", async () => {
    signUp.mockResolvedValue({
      data: { session: { access_token: "token" } },
      error: null,
    });

    await signUpAction(idleState, registerForm());

    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/panel?bienvenida=1");
  });

  it("sin sesión devuelve el aviso de confirmación y no redirige", async () => {
    const result = await signUpAction(idleState, registerForm());

    expect(result).toEqual({
      status: "success",
      message:
        "Te enviamos un email para confirmar tu cuenta. Confirmá y volvé a ingresar.",
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("solo pide los datos de la cuenta: sin ellos, ni siquiera llama a Supabase", async () => {
    const result = await signUpAction(
      idleState,
      registerForm({ fullName: "", email: "", password: "" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Revisá los datos del formulario.",
      fieldErrors: {
        fullName: "Ingresá tu nombre",
        email: "Email inválido",
        password: "La contraseña necesita al menos 8 caracteres",
      },
    });
    expect(signUp).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
