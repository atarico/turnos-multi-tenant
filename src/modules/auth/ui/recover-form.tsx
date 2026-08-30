"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { idleState } from "@/core/action";

import { requestPasswordResetAction } from "../application/actions";

interface RecoverFormProps {
  /**
   * El mail que la persona ya había tipeado en `/ingresar`, o `null` si llegó
   * a esta pantalla por su cuenta. La página lo valida antes de pasarlo: acá
   * llega o un mail bien formado, o nada.
   */
  knownEmail: string | null;
}

export function RecoverForm({ knownEmail }: RecoverFormProps) {
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

      {/*
        Dos formularios, no uno con el campo precargado.

        Con el mail ya sabido, mostrarlo como texto y no como input es a
        propósito: el paso que agrega valor es CONFIRMAR, y un campo editable
        invita a retipear justo el dato que ya estaba bien. El valor viaja en
        un `hidden`, así el action recibe siempre lo mismo se muestre como se
        muestre.

        Y la salida de "no es mío" es un link de vuelta a `/ingresar`, no un
        botón que borra el campo: quien se equivocó de mail se equivocó al
        ingresar, y ahí es donde tiene que corregirlo.
      */}
      {knownEmail ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-3">
            <p className="text-xs text-muted">Vamos a mandar el link a</p>
            <p className="mt-1 break-all text-sm font-medium text-fg">
              {knownEmail}
            </p>
          </div>
          <input type="hidden" name="email" value={knownEmail} />
          {fieldErrors?.email && <FieldError>{fieldErrors.email}</FieldError>}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Mandando el link…" : "Sí, es mío: mandame el link"}
          </Button>

          <p className="text-center text-xs">
            <Link href="/ingresar" className="text-muted hover:text-gold">
              No es mi mail, volver atrás
            </Link>
          </p>
        </div>
      ) : (
        <>
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
        </>
      )}
    </form>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}
