import { z } from "zod";

import { parsePriceToCents } from "./money";

/** Máximo razonable para un turno: un día entero. */
const MAX_DURATION_MIN = 24 * 60;

/**
 * Campo entero tipeado en un input de texto. El formulario manda strings, así
 * que la conversión y su mensaje de error viven en el schema y no en la UI.
 */
function wholeNumberField(options: {
  min: number;
  max: number;
  invalid: string;
  outOfRange: string;
}) {
  return z.string().trim().transform((raw, ctx) => {
    if (!/^\d+$/.test(raw)) {
      ctx.addIssue({ code: "custom", message: options.invalid });
      return z.NEVER;
    }
    const value = Number(raw);
    if (value < options.min || value > options.max) {
      ctx.addIssue({ code: "custom", message: options.outOfRange });
      return z.NEVER;
    }
    return value;
  });
}

const baseServiceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "El nombre es muy corto")
    .max(60, "Máximo 60 caracteres"),
  description: z
    .string()
    .trim()
    .max(200, "Máximo 200 caracteres")
    // Un campo vacío es "sin descripción", no una descripción vacía.
    .transform((value) => (value === "" ? null : value)),
  durationMin: wholeNumberField({
    min: 1,
    max: MAX_DURATION_MIN,
    invalid: "Poné la duración en minutos enteros",
    outOfRange: `La duración va de 1 a ${MAX_DURATION_MIN} minutos`,
  }),
  price: z.string().transform((raw, ctx) => {
    const cents = parsePriceToCents(raw);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Poné un precio válido (ej: 1.500,50)" });
      return z.NEVER;
    }
    return cents;
  }),
  capacity: wholeNumberField({
    min: 1,
    max: 100,
    invalid: "Poné un cupo en números enteros",
    outOfRange: "El cupo va de 1 a 100 personas",
  }),
});

/**
 * Formulario de servicio → valores de dominio. `price` (texto) sale como
 * `priceCents` para que nadie más abajo vuelva a tocar la representación.
 */
export const serviceFormSchema = baseServiceSchema.transform(
  ({ price, ...rest }) => ({ ...rest, priceCents: price }),
);

export type ServiceFormValues = z.infer<typeof serviceFormSchema>;
