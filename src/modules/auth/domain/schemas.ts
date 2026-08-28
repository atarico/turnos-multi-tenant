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
