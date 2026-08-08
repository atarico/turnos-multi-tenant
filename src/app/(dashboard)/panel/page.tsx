import type { Metadata } from "next";
import Link from "next/link";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  CalendarDays,
  Clock,
  LogOut,
  Plus,
  Scissors,
  Users,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { signOutAction } from "@/modules/auth/application/actions";
import {
  listBookingsToClose,
  listUpcomingBookings,
  sumMonthlyRevenue,
} from "@/modules/booking/application/queries";
import { AgendaList } from "@/modules/booking/ui/agenda-list";
import { formatPrice } from "@/modules/catalog/domain/money";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import { COUNTRY_LABELS } from "@/modules/tenants/domain/countries";
import type { PlanTier } from "@/modules/tenants/domain/types";
import { OnboardingForm } from "@/modules/tenants/ui/onboarding-form";

/** Instante ISO → "YYYY-MM-DD" civil en la tz del negocio. */
function civilDay(iso: string | number, timezone: string): string {
  return format(new TZDate(new Date(iso).getTime(), timezone), "yyyy-MM-dd");
}

/**
 * "Hoy" civil en la tz del negocio. Aislado en su propia función porque leer
 * el reloj es request-time: legítimo en un Server Component (render dinámico),
 * pero no debe vivir en el cuerpo "puro" del componente.
 */
function todayInTz(timezone: string): string {
  return civilDay(Date.now(), timezone);
}

/** Mes civil en curso en la tz del negocio, "YYYY-MM". Request-time, igual que `todayInTz`. */
function currentMonthInTz(timezone: string): string {
  return format(new TZDate(Date.now(), timezone), "yyyy-MM");
}

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

  const [bookingsResult, toCloseResult, revenueResult] = await Promise.all([
    listUpcomingBookings(tenant.id),
    listBookingsToClose(tenant.id),
    sumMonthlyRevenue(
      tenant.id,
      currentMonthInTz(tenant.timezone),
      tenant.timezone,
    ),
  ]);
  const bookings = bookingsResult.ok ? bookingsResult.value : [];
  const toClose = toCloseResult.ok ? toCloseResult.value : [];

  // Si la consulta falla se muestra "—", no "$0": un cero es un dato, y un dato
  // falso sobre la plata del negocio es peor que admitir que no se pudo leer.
  const ingresos = revenueResult.ok
    ? formatPrice(revenueResult.value.totalCents, revenueResult.value.currency)
    : "—";

  const todayStr = todayInTz(tenant.timezone);
  const turnosHoy = bookings.filter(
    (b) => civilDay(b.startsAt, tenant.timezone) === todayStr,
  ).length;
  const proximoTurno = bookings[0]
    ? format(
        new TZDate(new Date(bookings[0].startsAt).getTime(), tenant.timezone),
        "d MMM, HH:mm",
        { locale: es },
      )
    : "—";

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
        <div className="flex items-center gap-4">
          <Link
            href="/panel/servicios"
            className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            <Scissors className="size-4" />
            Servicios
          </Link>
          <Link
            href="/panel/profesionales"
            className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            <Users className="size-4" />
            Profesionales
          </Link>
          <Link
            href="/panel/nueva-reserva"
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-gold px-5 text-sm font-medium tracking-tight text-on-gold transition-all hover:bg-gold-bright active:scale-[0.98] shadow-[0_4px_24px_-6px_rgba(227,178,60,0.55)]"
          >
            <Plus className="size-4" />
            Nueva reserva
          </Link>
          <form action={signOutAction}>
            <button className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground">
              <LogOut className="size-4" />
              Salir
            </button>
          </form>
        </div>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <MetricCard
          icon={<CalendarDays className="size-5" />}
          label="Turnos hoy"
          value={String(turnosHoy)}
        />
        <MetricCard
          icon={<Wallet className="size-5" />}
          label="Ingresos del mes"
          value={ingresos}
        />
        <MetricCard
          icon={<Clock className="size-5" />}
          label="Próximo turno"
          value={proximoTurno}
        />
      </section>

      {/* Turnos vencidos sin cerrar: van ARRIBA de los próximos porque son los
          que piden una decisión ahora. Si no hay ninguno, la sección no existe
          y el panel queda como antes. */}
      {toClose.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 font-display text-lg font-semibold tracking-tight">
            Turnos a cerrar
          </h2>
          <p className="mb-3 text-sm text-muted">
            Ya pasaron y siguen abiertos. Marcá qué ocurrió para que dejen de
            figurar acá.
          </p>
          <AgendaList
            bookings={toClose}
            timezone={tenant.timezone}
            withActions
          />
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 font-display text-lg font-semibold tracking-tight">
          Próximos turnos
        </h2>
        {!bookingsResult.ok ? (
          <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {bookingsResult.error.message}
          </p>
        ) : (
          <AgendaList
            bookings={bookings}
            timezone={tenant.timezone}
            withActions
          />
        )}
      </section>
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
