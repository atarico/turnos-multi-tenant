import { beforeEach, describe, expect, it, vi } from "vitest";

import { idleState } from "@/core/action";

import {
  requestPasswordResetAction,
  signUpAction,
  updatePasswordAction,
} from "./actions";

/**
 * Tests de `signUpAction`: el registro crea SOLO la cuenta. El negocio lo crea
 * siempre el onboarding del panel, con sesión o sin ella, así que la action
 * nunca toca la RPC `create_business` ni pide nombre de negocio o país.
 *
 * Más abajo viven los dos pasos de la recuperación de contraseña. El pedido
 * del mail tiene una regla que no es de UX sino de seguridad: contesta lo
 * mismo exista o no la cuenta, así nadie puede usar el formulario para
 * averiguar quién es cliente.
 */

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirect(path),
}));

// Configurable, no fijo en `true`: cada action tiene que cortar antes de
// tocar Supabase cuando las credenciales todavía son placeholders, y eso sólo
// se prueba pudiendo apagarlo.
let supabaseConfigured = true;
vi.mock("@/lib/supabase/config", () => ({
  isSupabaseConfigured: () => supabaseConfigured,
}));

// El armado del `redirectTo` ya tiene sus propios tests en `reset-url.test.ts`.
// Acá se mockea con un centinela para poder afirmar que la action lo REENVÍA
// —que es lo que se rompe en silencio— sin depender de `NEXT_PUBLIC_APP_URL`.
const RESET_REDIRECT_URL = "https://turnos.app/auth/confirmar?next=%2Fx";
vi.mock("./reset-url", () => ({
  resolvePasswordResetRedirectUrl: () => RESET_REDIRECT_URL,
}));

const signUp = vi.fn(async () => ({
  data: { session: null as unknown },
  error: null as { message: string } | null,
}));
const rpc = vi.fn(async () => ({ error: null as { message: string } | null }));
const resetPasswordForEmail = vi.fn(async () => ({
  error: null as { message: string } | null,
}));
const updateUser = vi.fn(async () => ({
  error: null as { message: string } | null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { signUp, resetPasswordForEmail, updateUser },
    rpc,
  }),
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
  supabaseConfigured = true;
  signUp.mockResolvedValue({ data: { session: null }, error: null });
  rpc.mockResolvedValue({ error: null });
  resetPasswordForEmail.mockResolvedValue({ error: null });
  updateUser.mockResolvedValue({ error: null });
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

// ─────────────────────────────────────────────────────────────
// Pedido del mail de recuperación
// ─────────────────────────────────────────────────────────────

const SAME_ANSWER =
  "Si hay una cuenta con ese email, te mandamos el link para cambiar la contraseña.";

function recoverForm(email = "martina@negocio.com"): FormData {
  const form = new FormData();
  form.append("email", email);
  return form;
}

describe("requestPasswordResetAction", () => {
  it("le pide a Supabase el mail con el link al route handler", async () => {
    const result = await requestPasswordResetAction(idleState, recoverForm());

    expect(resetPasswordForEmail).toHaveBeenCalledWith("martina@negocio.com", {
      redirectTo: RESET_REDIRECT_URL,
    });
    expect(result).toEqual({ status: "success", message: SAME_ANSWER });
  });

  /**
   * El test que sostiene la privacidad de la cartera de clientes.
   *
   * Si el error de Supabase se filtrara a la respuesta, cualquiera podría
   * probar emails de a uno y quedarse con la lista de quién tiene cuenta acá.
   * Por eso la respuesta ante un error tiene que ser IDÉNTICA a la del éxito,
   * carácter por carácter, y no un mensaje "parecido".
   */
  it("contesta exactamente lo mismo cuando Supabase falla: no delata si el email existe", async () => {
    resetPasswordForEmail.mockResolvedValue({ error: { message: "User not found" } });

    const failed = await requestPasswordResetAction(idleState, recoverForm());

    resetPasswordForEmail.mockResolvedValue({ error: null });
    const succeeded = await requestPasswordResetAction(idleState, recoverForm());

    expect(failed).toEqual(succeeded);
    expect(failed).toEqual({ status: "success", message: SAME_ANSWER });
  });

  // Un email mal escrito SÍ se marca: eso no dice nada de quién tiene cuenta.
  it("rechaza un email inválido sin llamar a Supabase", async () => {
    const result = await requestPasswordResetAction(
      idleState,
      recoverForm("no-es-un-email"),
    );

    expect(result).toEqual({
      status: "error",
      message: "Revisá los datos del formulario.",
      fieldErrors: { email: "Email inválido" },
    });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("corta antes de tocar Supabase si las credenciales son placeholders", async () => {
    supabaseConfigured = false;

    const result = await requestPasswordResetAction(idleState, recoverForm());

    expect(result.status).toBe("error");
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Contraseña nueva
// ─────────────────────────────────────────────────────────────

function newPasswordForm(
  fields: Partial<Record<"password" | "passwordConfirm", string>> = {},
): FormData {
  const form = new FormData();
  form.append("password", fields.password ?? "claveNueva1");
  form.append("passwordConfirm", fields.passwordConfirm ?? "claveNueva1");
  return form;
}

describe("updatePasswordAction", () => {
  it("cambia la contraseña y manda al panel", async () => {
    await updatePasswordAction(idleState, newPasswordForm());

    expect(updateUser).toHaveBeenCalledWith({ password: "claveNueva1" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/panel");
  });

  it("con la confirmación distinta no toca Supabase y culpa al campo de confirmación", async () => {
    const result = await updatePasswordAction(
      idleState,
      newPasswordForm({ passwordConfirm: "otraClave1" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Revisá los datos del formulario.",
      fieldErrors: { passwordConfirm: "Las contraseñas no coinciden" },
    });
    expect(updateUser).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  // Sin sesión Supabase rechaza el cambio. La pantalla no puede quedar muda:
  // el error tiene que volver como estado, no como excepción ni como redirect.
  it("devuelve el error de Supabase sin redirigir", async () => {
    updateUser.mockResolvedValue({ error: { message: "Auth session missing!" } });

    const result = await updatePasswordAction(idleState, newPasswordForm());

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("corta antes de tocar Supabase si las credenciales son placeholders", async () => {
    supabaseConfigured = false;

    const result = await updatePasswordAction(idleState, newPasswordForm());

    expect(result.status).toBe("error");
    expect(updateUser).not.toHaveBeenCalled();
  });
});
