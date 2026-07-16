import { z } from "zod";

import { SUPPORTED_COUNTRIES } from "@/modules/tenants/domain/countries";

export const registerSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(2, "El nombre del negocio es muy corto")
    .max(60, "Máximo 60 caracteres"),
  country: z.enum(SUPPORTED_COUNTRIES, { message: "Elegí un país" }),
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
