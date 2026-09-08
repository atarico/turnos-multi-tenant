"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import { updatePasswordAction } from "../application/actions";

export function NewPasswordForm() {
  const [state, action, pending] = useActionState(
    updatePasswordAction,
    idleState,
  );
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  // No hay rama de éxito: cuando la contraseña se guarda, la action redirige
  // al panel. Si acá apareciera un cartel de "listo", sería porque el redirect
  // no pasó.
  return (
    <form action={action} className="space-y-4">
      {state.status === "error" && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}

      <div>
        <Label htmlFor="password">Contraseña nueva</Label>
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="Mínimo 8 caracteres"
          autoComplete="new-password"
        />
        {fieldErrors?.password && <FieldError>{fieldErrors.password}</FieldError>}
      </div>

      <div>
        <Label htmlFor="passwordConfirm">Repetí la contraseña</Label>
        <Input
          id="passwordConfirm"
          name="passwordConfirm"
          type="password"
          placeholder="La misma de arriba"
          autoComplete="new-password"
        />
        {fieldErrors?.passwordConfirm && (
          <FieldError>{fieldErrors.passwordConfirm}</FieldError>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Guardando…" : "Guardar contraseña"}
      </Button>
    </form>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}
