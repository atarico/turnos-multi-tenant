"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import { signInAction } from "../application/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(signInAction, idleState);
  const fieldErrors = state.status === "error" ? state.fieldErrors : undefined;

  /**
   * El mail se controla acá con un único fin: que el link de "olvidé mi
   * contraseña" se lo lleve puesto.
   *
   * Quien llega a ese link ya escribió su mail una vez y falló la contraseña.
   * Pedírselo de nuevo en la pantalla siguiente es hacerle repetir el único
   * dato que sí se acuerda, y es donde se cuelan los typos: si se equivoca al
   * retipearlo, el mail sale a una casilla que no es la suya y se queda
   * esperando algo que nunca llega.
   */
  const [email, setEmail] = useState("");
  const typed = email.trim();
  const recoverHref = typed
    ? `/recuperar?email=${encodeURIComponent(typed)}`
    : "/recuperar";

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
          value={email}
          onChange={(event) => setEmail(event.target.value)}
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
        {/*
          La salida para quien se olvidó la contraseña va PEGADA al campo que
          no puede completar: es el momento exacto en que se necesita, y nadie
          va a tipear /recuperar de memoria.
        */}
        <p className="mt-2 text-right text-xs">
          <Link href={recoverHref} className="text-muted hover:text-gold">
            ¿Olvidaste tu contraseña?
          </Link>
        </p>
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
