import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { RecoverForm } from "@/modules/auth/ui/recover-form";

export const metadata: Metadata = { title: "Recuperar contraseña" };

/**
 * La bandera que planta `/auth/confirmar` cuando el token no sirve.
 *
 * Es un valor fijo que se COMPARA, y el texto vive acá. Pintar lo que venga en
 * la URL convertiría esta pantalla en un cartel de alquiler: cualquiera
 * mandaría un link con el mensaje que se le ocurra —"escribinos a este
 * WhatsApp para desbloquear tu cuenta"— con nuestro dominio y nuestro diseño
 * alrededor.
 */
const EXPIRED_LINK_FLAG = "vencido";

interface RecuperarPageProps {
  // En esta versión de Next `searchParams` es una Promise y hay que esperarla.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function RecuperarPage({
  searchParams,
}: RecuperarPageProps) {
  const { link } = await searchParams;
  const linkExpired = link === EXPIRED_LINK_FLAG;

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Recuperar contraseña
        </h1>
        <p className="mt-2 text-sm text-muted">
          Te mandamos un link por mail para elegir una nueva.
        </p>
      </div>

      <Card className="p-6">
        {linkExpired && (
          <p className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            El link venció o ya se usó. Pedí uno nuevo y abrilo desde el mail
            más reciente.
          </p>
        )}
        <RecoverForm />
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        ¿Te acordaste?{" "}
        <Link href="/ingresar" className="text-gold hover:underline">
          Volvé a ingresar
        </Link>
      </p>
    </div>
  );
}
