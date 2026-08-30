import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Globe } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  grantCourtesyAction,
  revokeCourtesyAction,
} from "@/modules/admin/application/courtesy-actions";
import { getTenantDetail } from "@/modules/admin/application/tenant-detail";
import { utcDateLabel } from "@/modules/admin/domain/dates";
import { planIsOutOfSync } from "@/modules/admin/domain/plan-sync";
import { planLabel } from "@/modules/billing/domain/plan";
import type { SubscriptionStatus } from "@/modules/billing/domain/subscription";
import { CourtesyPanel } from "@/modules/admin/ui/courtesy-panel";
import { COUNTRY_LABELS } from "@/modules/tenants/domain/countries";

export const metadata: Metadata = { title: "Negocio" };

/**
 * Los cuatro estados se dicen en castellano y NO se colapsan.
 *
 * `past_due` en particular no es un `active` con una bandera: el cobro falló
 * pero el servicio sigue andando durante la gracia, y es justo el estado sobre
 * el que el operador tiene algo que hacer. Mostrarlo como "al día" escondería
 * a la única persona a la que hay que llamar.
 */
const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Prueba gratis",
  active: "Al día",
  past_due: "Cobro atrasado",
  canceled: "Cancelada",
};

const STATUS_VARIANTS: Record<
  SubscriptionStatus,
  "gold" | "info" | "muted" | "danger"
> = {
  trialing: "info",
  active: "gold",
  past_due: "danger",
  canceled: "muted",
};

interface AdminTenantDetailPageProps {
  params: Promise<{ slug: string }>;
}

export default async function AdminTenantDetailPage({
  params,
}: AdminTenantDetailPageProps) {
  const { slug } = await params;
  const result = await getTenantDetail(slug);

  // Las dos formas de "no hay negocio" se separan acá y es deliberado. Un slug
  // inexistente es un 404: quien tipeó mal la URL no tiene por qué ver una
  // pantalla que sugiere que el sistema se rompió. Un fallo de consulta pinta
  // el error, porque un 404 ahí le diría al operador que un negocio que SÍ
  // existe no existe, y lo manda a buscar el problema donde no está.
  if (!result.ok) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <BackLink />
        <p className="mt-8 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {result.error.message}
        </p>
      </div>
    );
  }

  if (!result.value) notFound();

  const { tenant, subscription, courtesy } = result.value;
  const outOfSync = planIsOutOfSync(tenant.plan, subscription);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <BackLink />

      <header className="mt-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {tenant.name}
        </h1>
        <p className="mt-1 font-mono text-sm text-muted">/{tenant.slug}</p>
      </header>

      {/* El aviso va ARRIBA de los datos, no al lado del plan que está mal:
          cuál de las dos columnas es la equivocada no lo sabemos —sabemos que
          no coinciden— y poner la marca en una sería afirmar algo que no
          verificamos. */}
      {outOfSync && subscription ? (
        <p className="mt-6 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            El plan del negocio y el de su suscripción <b>no coinciden</b>. El
            negocio está usando {planLabel(tenant.plan)} y lo que se pactó con
            la pasarela es {planLabel(subscription.plan)}.
          </span>
        </p>
      ) : null}

      <Card className="mt-6 divide-y divide-border">
        <Row label="Plan del negocio">
          <Badge variant="muted">{planLabel(tenant.plan)}</Badge>
        </Row>

        <Row label="Plan de la suscripción">
          {subscription ? (
            <div className="flex items-center gap-2">
              <Badge variant="muted">{planLabel(subscription.plan)}</Badge>
              <Badge variant={STATUS_VARIANTS[subscription.status]}>
                {STATUS_LABELS[subscription.status]}
              </Badge>
            </div>
          ) : (
            // Un hueco vacío se lee como "todavía no cargó". Decirlo con
            // palabras es la diferencia entre un dato y una duda.
            <span className="text-sm text-muted">Sin suscripción</span>
          )}
        </Row>

        {subscription ? (
          <Row label="Período">
            <span className="text-sm">
              {utcDateLabel(subscription.currentPeriodStart.toISOString())} →{" "}
              {utcDateLabel(subscription.currentPeriodEnd.toISOString())}
            </span>
          </Row>
        ) : null}

        {subscription?.trialEndsAt ? (
          <Row label="Fin de la prueba">
            <span className="text-sm">
              {utcDateLabel(subscription.trialEndsAt.toISOString())}
            </span>
          </Row>
        ) : null}

        <Row label="País">
          <span className="flex items-center gap-2 text-sm">
            <Globe className="size-4 text-faint" />
            {COUNTRY_LABELS[tenant.country]}
          </span>
        </Row>

        <Row label="Alta">
          <span className="text-sm">{utcDateLabel(tenant.created_at)}</span>
        </Row>
      </Card>

      <CourtesyPanel
        tenantId={tenant.id}
        slug={tenant.slug}
        paidPlan={tenant.plan}
        courtesy={courtesy}
        grant={grantCourtesyAction}
        revoke={revokeCourtesyAction}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin"
      className="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Negocios
    </Link>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}

