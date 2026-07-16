import Link from "next/link";
import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Sin Supabase configurado el panel no puede funcionar: mostramos una guía
  // en vez de un redirect confuso a una pantalla de login que tampoco anda.
  if (!isSupabaseConfigured()) {
    return <SetupNotice />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Guard de ruta: sin sesión, afuera.
  if (!user) redirect("/ingresar");

  return <div className="min-h-screen">{children}</div>;
}

function SetupNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Falta conectar Supabase
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          El panel necesita una base de datos real. Creá un proyecto gratis en
          supabase.com, completá tu{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 text-gold">
            .env.local
          </code>{" "}
          y aplicá las migrations con{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 text-gold">
            supabase db push
          </code>
          .
        </p>
        <Link
          href="/"
          className="mt-6 inline-block text-sm text-gold hover:underline"
        >
          ← Volver al inicio
        </Link>
      </div>
    </div>
  );
}
