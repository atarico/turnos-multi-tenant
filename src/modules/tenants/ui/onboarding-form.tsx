"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import { createBusinessAction } from "../application/actions";
import { COUNTRY_LABELS, SUPPORTED_COUNTRIES } from "../domain/countries";

export function OnboardingForm() {
  const [state, action, pending] = useActionState(
    createBusinessAction,
    idleState,
  );
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

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
        {fieldErrors?.businessName && (
          <p className="mt-1 text-xs text-danger">{fieldErrors.businessName}</p>
        )}
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
        {fieldErrors?.country && (
          <p className="mt-1 text-xs text-danger">{fieldErrors.country}</p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creando…" : "Crear negocio"}
      </Button>
    </form>
  );
}
