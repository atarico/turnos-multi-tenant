import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/modules/admin/application/queries";

/**
 * Guard del panel de plataforma. Es un grupo de rutas aparte de `(dashboard)`
 * y no una pantalla más adentro del panel porque lo que cambia es quién puede
 * entrar: al panel entra el dueño de un negocio, acá entra el dueño de la
 * plataforma. Compartir layout sería compartir el guard.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Mismo criterio que el panel: sin Supabase configurado no hay a quién
  // preguntarle si es admin, y un redirect al login tampoco andaría.
  if (!isSupabaseConfigured()) {
    return <SetupNotice />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/ingresar");

  /**
   * `notFound()` y no un 403 ni un redirect: los tres cierran la puerta, pero
   * sólo el 404 no admite que la puerta existe. Un "no tenés permiso" le
   * confirma a cualquier usuario logueado que hay un panel de plataforma y en
   * qué URL vive, que es exactamente la mitad del trabajo de quien busca una
   * escalada de privilegios. Para el que no es admin, esta ruta no existe.
   *
   * No es la única defensa, es la de arriba de todo: aun salteándola, la RLS
   * le devuelve sólo sus propios negocios. Pero es la que evita el papelón de
   * publicar el mapa.
   */
  if (!(await isSuperAdmin())) notFound();

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
          La administración de la plataforma lee la base de datos real. Creá un
          proyecto gratis en supabase.com, completá tu{" "}
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
