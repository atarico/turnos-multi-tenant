import { z } from "zod";

/**
 * Formulario de profesional → valores de dominio.
 *
 * `serviceIds` llega del `formData.getAll("serviceIds")` de los checkboxes. Se
 * valida que cada uno sea un uuid ANTES de tocar la base: un id con forma rara
 * es un intento de POST a mano, no un click. Que pertenezcan al negocio se
 * verifica en la action, que es la única que conoce el tenant.
 */
export const staffFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "El nombre es muy corto")
    .max(60, "Máximo 60 caracteres"),
  role: z
    .string()
    .trim()
    .max(40, "Máximo 40 caracteres")
    // Un campo vacío es "sin especialidad", no una especialidad vacía.
    .transform((value) => (value === "" ? null : value)),
  serviceIds: z
    .array(z.uuid("Alguno de los servicios elegidos no es válido"))
    // Un checkbox no debería repetirse, pero el FormData es del cliente.
    .transform((ids) => [...new Set(ids)]),
});

export type StaffFormValues = z.infer<typeof staffFormSchema>;
