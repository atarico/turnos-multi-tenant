"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { type ActionState, errorState, zodFieldErrors } from "@/core/action";
import { createClient } from "@/lib/supabase/server";

/**
 * Crear y apagar cupones desde el panel de plataforma.
 *
 * La autorización NO se repite acá: vive dentro de `create_coupon` y
 * `set_coupon_active`, que chequean `is_super_admin()` en la base. Dos rejas se
 * desincronizan, y el día que alguien relaja una "porque la otra ya chequea" no
 * se sabe cuál valía.
 *
 * Se llaman con el cliente de SESIÓN: `created_by` sale de `auth.uid()` adentro
 * de la función, y con la service key no habría a quién anotar.
 */

const createSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "El código necesita al menos dos caracteres.")
    .max(32, "El código no puede pasar de 32 caracteres.")
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9-]*$/,
      "Sólo letras, números y guiones, y no puede empezar con guión.",
    ),
  // Se pide en PORCENTAJE y se guarda en puntos básicos. Nadie escribe 9900
  // queriendo decir 99, y pedirlo en bps es trasladarle al operador una
  // decisión de precisión que se tomó en la base.
  percent: z.coerce
    .number()
    .gt(0, "El descuento tiene que ser mayor que cero.")
    .lte(99, "El máximo es 99%: un 100% deja el cobro en cero y Mercado Pago lo rechaza."),
  note: z.string().trim().max(200).optional(),
  expiresAt: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  maxRedemptions: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .nullable()
    .refine((v) => v === null || (Number.isInteger(v) && v > 0), {
      message: "El tope tiene que ser un número entero mayor que cero.",
    }),
});

export async function createCouponAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createSchema.safeParse({
    code: formData.get("code"),
    percent: formData.get("percent"),
    note: formData.get("note") ?? undefined,
    expiresAt: formData.get("expiresAt"),
    maxRedemptions: formData.get("maxRedemptions"),
  });

  if (!parsed.success) {
    return errorState("Revisá los datos.", zodFieldErrors(parsed.error));
  }

  const { code, percent, note, expiresAt, maxRedemptions } = parsed.data;
  const supabase = await createClient();

  const { error } = await supabase.rpc("create_coupon", {
    p_code: code,
    // El redondeo evita que un 12,345% llegue como 1234.5 y la columna `int` lo
    // rechace con un error de tipo que nadie puede accionar.
    p_discount_bps: Math.round(percent * 100),
    p_note: note ?? null,
    // Una fecha suelta es medianoche UTC de ese día: el cupón vence al EMPEZAR
    // el día elegido, igual que la cortesía.
    p_expires_at: expiresAt ? `${expiresAt}T00:00:00Z` : null,
    p_max_redemptions: maxRedemptions,
  });

  if (error) return errorState(couponError(error.message));

  revalidatePath("/admin/cupones");
  return { status: "success", message: "Cupón creado." };
}

export async function toggleCouponAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const code = z.string().trim().min(1).safeParse(formData.get("code"));
  if (!code.success) return errorState("Cupón inválido.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_coupon_active", {
    p_code: code.data,
    // El estado deseado viaja en el form. Leer el actual acá y negarlo abriría
    // una carrera: dos clicks seguidos leerían el mismo valor y el segundo
    // desharía al primero sin que nadie lo pidiera.
    p_active: formData.get("active") === "true",
  });

  if (error) return errorState(couponError(error.message));

  revalidatePath("/admin/cupones");
  return { status: "success" };
}

/**
 * El mensaje de Postgres no se muestra tal cual: trae el nombre de la función y
 * a veces el del índice, y nada de eso le sirve a quien mira la pantalla.
 */
function couponError(message: string): string {
  if (message.includes("solo un operador de plataforma")) {
    return "Tu cuenta no puede administrar cupones.";
  }
  if (message.includes("ya existe un cupon")) {
    return "Ya existe un cupón con ese código.";
  }
  if (message.includes("vencimiento")) {
    return "El vencimiento tiene que ser una fecha futura.";
  }
  if (message.includes("no existe el cupon")) {
    return "Ese cupón ya no existe.";
  }
  return "No pudimos guardar el cambio. Intentá de nuevo.";
}
