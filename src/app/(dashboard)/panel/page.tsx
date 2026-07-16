import type { Metadata } from "next";
import { CalendarDays, Clock, LogOut, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { signOutAction } from "@/modules/auth/application/actions";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import { COUNTRY_LABELS } from "@/modules/tenants/domain/countries";
import type { PlanTier } from "@/modules/tenants/domain/types";
import { OnboardingForm } from "@/modules/tenants/ui/onboarding-form";

export const metadata: Metadata = { title: "Panel" };

const PLAN_LABELS: Record<PlanTier, string> = {
  basico: "Básico",
  pro: "Pro",
  premium: "Premium",
};

export default async function PanelPage() {
  const tenant = await getCurrentTenant();

  // Autenticado pero sin negocio (p. ej. registro con confirmación de email).
  if (!tenant) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Creá tu negocio
        </h1>
        <p className="mt-2 text-sm text-muted">Un último paso para arrancar.</p>
        <div className="mt-6">
          <OnboardingForm />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {tenant.name}
            </h1>
            <Badge variant="gold">{PLAN_LABELS[tenant.plan]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            turnos.app/{tenant.slug} · {COUNTRY_LABELS[tenant.country]}
          </p>
        </div>
        <form action={signOutAction}>
          <button className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground">
            <LogOut className="size-4" />
            Salir
          </button>
        </form>
      </header>

      {/* Métricas — placeholders que se activan en las próximas fases. */}
      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <MetricCard icon={<CalendarDays className="size-5" />} label="Turnos hoy" value="0" />
        <MetricCard icon={<Wallet className="size-5" />} label="Ingresos del mes" value="$0" />
        <MetricCard icon={<Clock className="size-5" />} label="Próximo turno" value="—" />
      </section>

      <Card className="mt-4 p-6">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          El cimiento está listo ✓
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          Autenticación, multi-tenant con RLS y tu negocio aislado de los demás.
          Lo que sigue: <strong className="text-foreground">servicios y calendario</strong>{" "}
          (Fase 2), <strong className="text-foreground">pagos</strong> según tu país
          (Fase 3) y el resto del dashboard.
        </p>
      </Card>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-muted">
        <span className="text-gold">{icon}</span>
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-3 font-display text-3xl font-semibold tracking-tight">
        {value}
      </p>
    </Card>
  );
}
