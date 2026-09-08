import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Ticket } from "lucide-react";

import {
  createCouponAction,
  toggleCouponAction,
} from "@/modules/admin/application/coupon-actions";
import { listCoupons } from "@/modules/admin/application/coupons";
import { CouponAdmin } from "@/modules/admin/ui/coupon-admin";

export const metadata: Metadata = { title: "Cupones" };

export default async function CuponesPage() {
  const result = await listCoupons();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <Link
        href="/admin"
        className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Negocios
      </Link>

      <header className="mt-6">
        <div className="flex items-center gap-2 text-sm text-gold">
          <Ticket className="size-4" />
          Plataforma
        </div>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">
          Cupones
        </h1>
        <p className="mt-1 text-sm text-muted">
          Descuentos permanentes: el precio rebajado rige mientras dure la
          suscripción.
        </p>
      </header>

      {/* Un fallo de consulta NO se pinta como "no hay cupones": el siguiente
          paso obvio sería crear uno que ya existe, y el código chocaría. */}
      {!result.ok ? (
        <p className="mt-8 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {result.error.message}
        </p>
      ) : (
        <CouponAdmin
          coupons={result.value}
          // El instante se calcula en el SERVIDOR y viaja. Dejárselo al reloj
          // del navegador haría que un cupón se viera vencido o no según la
          // hora de la máquina de quien mira.
          now={new Date().toISOString()}
          create={createCouponAction}
          toggle={toggleCouponAction}
        />
      )}
    </div>
  );
}
