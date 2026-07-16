import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { LoginForm } from "@/modules/auth/ui/login-form";

export const metadata: Metadata = { title: "Ingresar" };

export default function IngresarPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Bienvenido de vuelta
        </h1>
        <p className="mt-2 text-sm text-muted">
          Ingresá para ver tu agenda.
        </p>
      </div>

      <Card className="p-6">
        <LoginForm />
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        ¿No tenés cuenta?{" "}
        <Link href="/registro" className="text-gold hover:underline">
          Creá tu negocio
        </Link>
      </p>
    </div>
  );
}
