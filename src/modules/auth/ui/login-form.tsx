"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import { signInAction } from "../application/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signInAction, idleState);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

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

      <div>
        <Label htmlFor="password">Contraseña</Label>
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="Tu contraseña"
          autoComplete="current-password"
        />
        {fieldErrors?.password && <FieldError>{fieldErrors.password}</FieldError>}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Ingresando…" : "Ingresar"}
      </Button>
    </form>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}
