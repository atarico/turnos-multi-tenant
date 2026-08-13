"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

import { loginSchema, registerSchema } from "../domain/schemas";

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
