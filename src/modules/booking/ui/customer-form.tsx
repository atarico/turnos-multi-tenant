"use client";

import { Input, Label } from "@/components/ui/input";
import type { CustomerInput } from "../domain/schemas";

interface CustomerFormProps {
  values: CustomerInput;
  onChange: (values: CustomerInput) => void;
  errors?: Record<string, string>;
}

/**
 * Datos del cliente (nombre / email / teléfono). Componente CONTROLADO: el
 * estado vive en el flujo, que valida con `customerSchema` antes de confirmar.
 * Sólo el nombre es obligatorio; email y teléfono son opcionales.
 */
export function CustomerForm({ values, onChange, errors }: CustomerFormProps) {
  const set = (key: keyof CustomerInput) => (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => onChange({ ...values, [key]: event.target.value });

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="customer_name">Nombre del cliente</Label>
        <Input
          id="customer_name"
          name="customer_name"
          value={values.customer_name}
          onChange={set("customer_name")}
          placeholder="Ej. María González"
          autoComplete="name"
          aria-invalid={Boolean(errors?.customer_name)}
        />
        {errors?.customer_name && <FieldError>{errors.customer_name}</FieldError>}
      </div>

      <div>
        <Label htmlFor="customer_email">Email (opcional)</Label>
        <Input
          id="customer_email"
          name="customer_email"
          type="email"
          value={values.customer_email ?? ""}
          onChange={set("customer_email")}
          placeholder="cliente@email.com"
          autoComplete="email"
          aria-invalid={Boolean(errors?.customer_email)}
        />
        {errors?.customer_email && <FieldError>{errors.customer_email}</FieldError>}
      </div>

      <div>
        <Label htmlFor="customer_phone">Teléfono (opcional)</Label>
        <Input
          id="customer_phone"
          name="customer_phone"
          type="tel"
          value={values.customer_phone ?? ""}
          onChange={set("customer_phone")}
          placeholder="+54 9 11 1234 5678"
          autoComplete="tel"
          aria-invalid={Boolean(errors?.customer_phone)}
        />
        {errors?.customer_phone && <FieldError>{errors.customer_phone}</FieldError>}
      </div>
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}
