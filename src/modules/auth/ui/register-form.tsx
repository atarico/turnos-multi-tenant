"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import {
  COUNTRY_LABELS,
  SUPPORTED_COUNTRIES,
} from "@/modules/tenants/domain/countries";

import { signUpAction } from "../application/actions";

export function RegisterForm() {
  const [state, action, pending] = useActionState(signUpAction, idleState);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  if (state.status === "success") {
    return (
      <div className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm text-success">
        {state.message}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state.status === "error" && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}

      <div>
        <Label htmlFor="businessName">Nombre del negocio</Label>
        <Input
          id="businessName"
          name="businessName"
          placeholder="Estudio Pilates Centro"
          autoComplete="organization"
        />
        {fieldErrors?.businessName && <FieldError>{fieldErrors.businessName}</FieldError>}
      </div>

      <div>
        <Label htmlFor="country">País</Label>
        <select
          id="country"
          name="country"
          defaultValue=""
          className="h-11 w-full rounded-xl border border-border bg-surface-2 px-3.5 text-sm text-foreground focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/15"
        >
          <option value="" disabled>
            Elegí un país
          </option>
          {SUPPORTED_COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {COUNTRY_LABELS[c]}
            </option>
          ))}
        </select>
        {fieldErrors?.country && <FieldError>{fieldErrors.country}</FieldError>}
      </div>

      <div>
        <Label htmlFor="fullName">Tu nombre</Label>
        <Input
          id="fullName"
          name="fullName"
          placeholder="Martina Ríos"
          autoComplete="name"
        />
        {fieldErrors?.fullName && <FieldError>{fieldErrors.fullName}</FieldError>}
      </div>

      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          placeholder="vos@negocio.com"
          autoComplete="email"
        />
        {fieldErrors?.email && <FieldError>{fieldErrors.email}</FieldError>}
      </div>

      <div>
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="Mínimo 8 caracteres"
          autoComplete="new-password"
        />
        {fieldErrors?.password && <FieldError>{fieldErrors.password}</FieldError>}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creando tu negocio…" : "Crear mi negocio"}
      </Button>
    </form>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}
