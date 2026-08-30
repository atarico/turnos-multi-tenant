import type { Metadata } from "next";
import Link from "next/link";
import {
  Building2,
  CalendarDays,
  Globe,
  LogOut,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { listAllTenants } from "@/modules/admin/application/queries";
import { signOutAction } from "@/modules/auth/application/actions";
import { utcDateLabel } from "@/modules/admin/domain/dates";
import type { AdminTenant } from "@/modules/admin/domain/types";
import { planLabel } from "@/modules/billing/domain/plan";
import { COUNTRY_LABELS } from "@/modules/tenants/domain/countries";
import type { PlanTier } from "@/modules/tenants/domain/types";

export const metadata: Metadata = { title: "Administración" };

/**
 * El color del plan es la única jerarquía visual de la lista: el ojo tiene que
 * poder barrer cien negocios y frenar en los que pagan más sin leer palabra.
 */
const PLAN_VARIANTS: Record<PlanTier, "gold" | "info" | "muted"> = {
  premium: "gold",
  pro: "info",
  basico: "muted",
};


export default async function AdminPage() {
  const result = await listAllTenants();

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-gold">
            <ShieldCheck className="size-4" />
            Plataforma
          </div>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">
            Administración
          </h1>
          <p className="mt-1 text-sm text-muted">
            Todos los negocios dados de alta, del más nuevo al más viejo.
          </p>
        </div>

        {/* Esta pantalla no tiene menú ni ninguna otra navegación, y el operador
            aterriza acá al ingresar: sin esta salida, cerrar sesión sería
            borrar la cookie a mano. */}
        <form action={signOutAction}>
          <button className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground">
            <LogOut className="size-4" />
            Salir
          </button>
        </form>
      </header>

      {/* Las tres salidas son excluyentes y se ven distinto a propósito: un
          fallo de consulta y una plataforma vacía pintan las dos una pantalla
          sin filas, y confundirlas es decirle al dueño que no tiene clientes
          cuando lo que pasó es que la base no contestó. */}
      {!result.ok ? (
        <p className="mt-8 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {result.error.message}
        </p>
      ) : result.value.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="mt-8 space-y-3">
          {result.value.map((tenant) => (
            <li key={tenant.id}>
              {/* La fila ENTERA es el link, no un "ver detalle" al costado: el
                  objetivo de click es la tarjeta que el ojo ya está mirando. */}
              <Link
                href={`/admin/${tenant.slug}`}
                className="block rounded-2xl transition-opacity hover:opacity-80"
              >
                <TenantRow tenant={tenant} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TenantRow({ tenant }: { tenant: AdminTenant }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="font-display text-base font-semibold tracking-tight">
            {tenant.name}
          </h2>
          <Badge variant={PLAN_VARIANTS[tenant.plan]}>
            {planLabel(tenant.plan)}
          </Badge>
        </div>
        {/* El slug con la barra adelante y no el nombre: dos negocios se pueden
            llamar igual, la URL es lo que los distingue de verdad. */}
        <p className="mt-1 font-mono text-sm text-muted">/{tenant.slug}</p>
      </div>
      <dl className="flex items-center gap-6 text-sm text-muted">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-faint" />
          <dt className="sr-only">País</dt>
          <dd>{COUNTRY_LABELS[tenant.country]}</dd>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-faint" />
          <dt className="sr-only">Alta</dt>
          <dd>{utcDateLabel(tenant.created_at)}</dd>
        </div>
      </dl>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="mt-8 flex flex-col items-center px-6 py-12 text-center">
      <Building2 className="size-6 text-faint" />
      <p className="mt-3 text-sm text-muted">
        Todavía no hay ningún negocio en la plataforma.
      </p>
    </Card>
  );
}
