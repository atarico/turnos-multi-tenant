"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import { requestPasswordResetAction } from "../application/actions";

export function RecoverForm() {
  const [state, action, pending] = useActionState(
    requestPasswordResetAction,
    idleState,
  );
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  // El éxito reemplaza al formulario, como en el registro. Dejar el campo a la
  // vista invitaría a mandarlo de nuevo, y Supabase limita los reenvíos: el
  // segundo intento no trae otro mail, trae un rechazo.
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

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Mandando el link…" : "Mandarme el link"}
      </Button>
    </form>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}
