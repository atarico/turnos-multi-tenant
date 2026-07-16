import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { RegisterForm } from "@/modules/auth/ui/register-form";

export const metadata: Metadata = { title: "Crear mi negocio" };

export default function RegistroPage() {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Creá tu negocio
        </h1>
        <p className="mt-2 text-sm text-muted">
          Empezá a recibir reservas en minutos.
        </p>
      </div>

      <Card className="p-6">
        <RegisterForm />
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        ¿Ya tenés cuenta?{" "}
        <Link href="/ingresar" className="text-gold hover:underline">
          Ingresá
        </Link>
      </p>
    </div>
  );
}
