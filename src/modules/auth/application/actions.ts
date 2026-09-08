"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

import {
  loginSchema,
  newPasswordSchema,
  recoverSchema,
  registerSchema,
} from "../domain/schemas";

import { resolvePasswordResetRedirectUrl } from "./reset-url";

/** Traduce los errores crudos de Supabase Auth a algo que el usuario entienda. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("already registered") || m.includes("already exists"))
    return "Ese email ya tiene una cuenta. Probá ingresar.";
  if (m.includes("invalid login credentials"))
    return "Email o contraseña incorrectos.";
  if (m.includes("email not confirmed"))
    return "Todavía no confirmaste tu email. Revisá tu casilla.";
  return "No pudimos completar la operación. Probá de nuevo.";
}

// ─────────────────────────────────────────────────────────────
// Registro de la cuenta (el negocio lo crea el onboarding del panel)
// ─────────────────────────────────────────────────────────────
export async function signUpAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!isSupabaseConfigured()) {
    return errorState(
      "Supabase todavía no está configurado. Completá tu .env.local con las credenciales reales.",
    );
  }

  const parsed = registerSchema.safeParse({
    fullName: String(formData.get("fullName") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });

  if (!parsed.success) {
    return errorState("Revisá los datos del formulario.", zodFieldErrors(parsed.error));
  }

  const { fullName, email, password } = parsed.data;
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });

  if (error) {
    return errorState(friendlyAuthError(error.message));
  }

  // Con "Confirm email" activado no hay sesión todavía: el negocio se crea
  // igual, en el onboarding del panel, después del primer login.
  if (!data.session) {
    return {
      status: "success",
      message: "Te enviamos un email para confirmar tu cuenta. Confirmá y volvé a ingresar.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/panel?bienvenida=1");
}

// ─────────────────────────────────────────────────────────────
// Ingreso
// ─────────────────────────────────────────────────────────────
export async function signInAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!isSupabaseConfigured()) {
    return errorState(
      "Supabase todavía no está configurado. Completá tu .env.local con las credenciales reales.",
    );
  }

  const parsed = loginSchema.safeParse({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });

  if (!parsed.success) {
    return errorState("Revisá los datos del formulario.", zodFieldErrors(parsed.error));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return errorState(friendlyAuthError(error.message));
  }

  revalidatePath("/", "layout");
  redirect("/panel?bienvenida=1");
}

// ─────────────────────────────────────────────────────────────
// Salir
// ─────────────────────────────────────────────────────────────
export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/ingresar");
}

// ─────────────────────────────────────────────────────────────
// Recuperación de contraseña — paso 1: pedir el mail
// ─────────────────────────────────────────────────────────────
export async function requestPasswordResetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!isSupabaseConfigured()) {
    return errorState(
      "Supabase todavía no está configurado. Completá tu .env.local con las credenciales reales.",
    );
  }

  const parsed = recoverSchema.safeParse({
    email: String(formData.get("email") ?? ""),
  });

  if (!parsed.success) {
    return errorState("Revisá los datos del formulario.", zodFieldErrors(parsed.error));
  }

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: resolvePasswordResetRedirectUrl(),
  });

  // El `error` se ignora A PROPÓSITO, y es la única action del proyecto que lo
  // hace.
  //
  // Este formulario no pide sesión: le pega cualquiera, tantas veces como
  // quiera. Si contestara distinto según el email exista o no —un error acá,
  // un éxito allá— sería un buscador de clientes: probando direcciones de a
  // una se arma la lista de qué negocios trabajan con nosotros, y esa lista es
  // justo lo que un competidor quiere. Por eso la respuesta es UNA SOLA,
  // idéntica en los dos casos, y por eso está redactada en condicional: no
  // afirma que el mail salió, porque no puede afirmarlo sin delatar.
  //
  // Lo que se pierde es diagnóstico, y se acepta: quien tiene cuenta recibe el
  // mail igual, y el resto no aprende nada. Si algo falla del lado de
  // Supabase, se ve en sus logs, no en la pantalla de un desconocido.
  return {
    status: "success",
    message:
      "Si hay una cuenta con ese email, te mandamos el link para cambiar la contraseña.",
  };
}

// ─────────────────────────────────────────────────────────────
// Recuperación de contraseña — paso 2: guardar la nueva
// ─────────────────────────────────────────────────────────────
export async function updatePasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  if (!isSupabaseConfigured()) {
    return errorState(
      "Supabase todavía no está configurado. Completá tu .env.local con las credenciales reales.",
    );
  }

  const parsed = newPasswordSchema.safeParse({
    password: String(formData.get("password") ?? ""),
    passwordConfirm: String(formData.get("passwordConfirm") ?? ""),
  });

  if (!parsed.success) {
    return errorState("Revisá los datos del formulario.", zodFieldErrors(parsed.error));
  }

  const supabase = await createClient();

  // Acá no hay email ni token: `updateUser` cambia la contraseña del usuario
  // DE LA SESIÓN, y la sesión la abrió el route handler al canjear el
  // `token_hash` del mail. Sin ese paso previo esto falla, y esa falla es la
  // que impide que un desconocido cambie la clave de otro.
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    // El caso típico es la sesión vencida entre que se abrió el link y se
    // mandó el formulario. Devolverlo como estado —y no dejarlo explotar—
    // deja la pantalla usable, con el link para pedir uno nuevo a la vista.
    return errorState(friendlyAuthError(error.message));
  }

  revalidatePath("/", "layout");
  redirect("/panel");
}
