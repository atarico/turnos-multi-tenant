import { z } from "zod";

/**
 * Datos del cliente para la reserva. El email es opcional (el negocio puede
 * cargar un turno sin mail); si viene, tiene que ser válido. El teléfono es
 * texto libre acotado (formatos varían por país).
 */
export const customerSchema = z.object({
  customer_name: z
    .string()
    .trim()
    .min(2, "Ingresá el nombre del cliente")
    .max(80, "Máximo 80 caracteres"),
  customer_email: z
    .union([z.literal(""), z.email("Email inválido")])
    .optional(),
  customer_phone: z
    .string()
    .trim()
    .max(30, "Máximo 30 caracteres")
    .optional(),
});

export type CustomerInput = z.infer<typeof customerSchema>;

/**
 * Payload completo del formulario de reserva que consume la Server Action.
 * `starts_at` es el instante ISO (UTC, con Z) elegido en la grilla de franjas.
 * `create_booking()` revalida todo en la base: esto es sólo la primera barrera.
 */
export const bookingSchema = z.object({
  service_id: z.uuid("Servicio inválido"),
  staff_id: z.uuid("Profesional inválido"),
  starts_at: z.iso.datetime("Franja inválida"),
  ...customerSchema.shape,
});

export type BookingInput = z.infer<typeof bookingSchema>;
