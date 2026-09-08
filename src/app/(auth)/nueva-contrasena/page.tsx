import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { NewPasswordForm } from "@/modules/auth/ui/new-password-form";

export const metadata: Metadata = { title: "Nueva contraseña" };

export default async function NuevaContrasenaPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  /**
   * El guard de la pantalla más sensible del flujo: acá se cambia una
   * contraseña sin pedir la anterior, y lo único que lo autoriza es la sesión
   * que abrió `/auth/confirmar` al canjear el token del mail.
   *
   * Sin sesión el formulario NO se muestra —ni deshabilitado, ni vacío—: un
   * formulario a la vista dice "probá", y quien llegó de más no tiene nada que
   * probar. Se lo manda a pedir el link, que es lo que le falta.
   *
   * El guard real igual lo pone Supabase: `updateUser` sin sesión falla. Esto
   * es para que nadie llegue a un callejón sin salida, no un segundo candado.
   */
  if (!user) redirect("/recuperar");

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Elegí tu contraseña nueva
        </h1>
        <p className="mt-2 text-sm text-muted">
          Con esta vas a entrar de ahora en más.
        </p>
      </div>

      <Card className="p-6">
        <NewPasswordForm />
      </Card>
    </div>
  );
}
