import { z } from "zod";

/** El alta pide sólo la cuenta: el negocio lo crea el onboarding del panel. */
export const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Ingresá tu nombre"),
  email: z.email("Email inválido"),
  password: z.string().min(8, "La contraseña necesita al menos 8 caracteres"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email("Email inválido"),
  password: z.string().min(1, "Ingresá tu contraseña"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** La recuperación pide sólo el email: quien la usa no tiene la contraseña. */
export const recoverSchema = z.object({
  email: z.email("Email inválido"),
});

export type RecoverInput = z.infer<typeof recoverSchema>;

/**
 * La contraseña nueva, ya con la sesión abierta por el link del mail.
 *
 * No pide la contraseña anterior a propósito: todo este flujo existe para
 * quien justamente no la tiene. La confirmación es el único control contra el
 * typo, y el error se cuelga de `passwordConfirm` porque `zodFieldErrors`
 * pinta cada mensaje bajo el input que el `path` nombra; señalar `password`
 * mandaría a corregir el campo que probablemente estaba bien.
 */
export const newPasswordSchema = z
  .object({
    password: z.string().min(8, "La contraseña necesita al menos 8 caracteres"),
    passwordConfirm: z.string(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    error: "Las contraseñas no coinciden",
    path: ["passwordConfirm"],
  });

export type NewPasswordInput = z.infer<typeof newPasswordSchema>;
