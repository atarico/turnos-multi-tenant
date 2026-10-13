import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ArrowLeft, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  disconnectMpAction,
  markPaymentRefundedAction,
  toggleOnlinePaymentsAction,
} from "@/modules/payments/application/actions";
import {
  canMarkRefunds,
  currentOwnerTenant,
} from "@/modules/payments/application/ownership";
import { getPaymentsState } from "@/modules/payments/application/queries";
import {
  listPaymentsToRefund,
  type PaymentToRefund,
} from "@/modules/payments/application/refunds";
import { formatPrice } from "@/modules/catalog/domain/money";
import {
  PAYMENTS_FLAGS,
  parsePaymentsFlag,
  type FlagTone,
} from "@/modules/payments/domain/panel-flags";
import { planAllowsOnlinePayments } from "@/modules/billing/domain/plan";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

export const metadata: Metadata = { title: "Pagos" };

/** El botón de conectar es un `<a>` y no un `<Link>`: ver el comentario en la tarjeta. */
const CONNECT_HREF = "/api/payments/mp/connect";

const TONE_CLASSES: Record<FlagTone, string> = {
  ok: "border-gold/30 bg-gold/10 text-foreground",
  info: "border-border bg-surface-2 text-muted",
  error: "border-danger/30 bg-danger/10 text-danger",
};

interface PagosPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Pagos online del negocio: conectar la cuenta de Mercado Pago, y decidir si
 * los clientes pagan al reservar.
 *
 * Todo lo que llega por la URL es una CLAVE (`?mp=`) que se compara contra una
 * tabla fija; el texto vive en `panel-flags`. Nada de la URL se imprime.
 *
 * Qué ve cada quien: el dueño tiene los controles; un miembro que no es dueño
 * ve el estado y nada más (la base igual lo rechazaría, esto es para no
 * ofrecerle botones que no andan). Los tokens no llegan ni a esta página: sólo
 * se lee si hay cuenta, su estado y su fecha.
 */
export default async function PagosPage({ searchParams }: PagosPageProps) {
  const { mp } = await searchParams;
  const tenant = await getCurrentTenant();
  // Mismo criterio que /configuracion y /suscripcion: sin negocio, el panel decide.
  if (!tenant) redirect("/panel");

  const flag = parsePaymentsFlag(mp);
  const [owner, stateResult, refundsResult, canRefund] = await Promise.all([
    currentOwnerTenant(),
    getPaymentsState(tenant.id),
    listPaymentsToRefund(tenant.id),
    canMarkRefunds(tenant.id),
  ]);
  const isOwner = owner.ok;

  // El plan EFECTIVO: la prueba viva y la cortesía ya vienen resueltas.
  const eligible = planAllowsOnlinePayments(tenant.plan);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <Link href="/panel" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          <ArrowLeft className="size-4" />
          Volver al panel general
        </Link>
        <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">
          Pagos online
        </h1>
        <p className="mt-1 text-sm text-muted">
          Cobrá los turnos con tu propia cuenta de Mercado Pago. La plata va
          directo a tu cuenta: nosotros no la tocamos ni nos quedamos con una
          parte.
        </p>
      </header>

      {flag && (
        <p
          role="status"
          className={`mt-6 rounded-xl border px-3.5 py-3 text-sm ${TONE_CLASSES[PAYMENTS_FLAGS[flag].tone]}`}
        >
          {PAYMENTS_FLAGS[flag].message}
        </p>
      )}

      {!stateResult.ok ? (
        <p className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-sm text-danger">
          No pudimos leer el estado de tus pagos online. Recargá la página en
          un momento.
        </p>
      ) : (
        <PaymentsBody
          eligible={eligible}
          isOwner={isOwner}
          enabled={stateResult.value.enabled}
          account={stateResult.value.account}
          timezone={tenant.timezone}
        />
      )}

      {/* Va aparte del estado de la cuenta: la plata ya cobrada se debe aunque
          el plan haya bajado o la cuenta se haya roto. */}
      {!refundsResult.ok ? (
        <p className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-sm text-danger">
          No pudimos leer los pagos a devolver. Recargá la página en un momento.
        </p>
      ) : (
        refundsResult.value.length > 0 && (
          <RefundsSection
            refunds={refundsResult.value}
            canMark={canRefund}
            timezone={tenant.timezone}
          />
        )
      )}
    </div>
  );
}

/**
 * Pagos que el dueño todavía tiene que devolver (turnos pagados que se
 * cancelaron, o plata cobrada de más). La devolución se hace en Mercado Pago;
 * el botón sólo cierra el "a devolver" acá. Lo ve cualquier miembro, pero sólo
 * dueño o admin lo pueden marcar (la base lo vuelve a exigir).
 */
function RefundsSection({
  refunds,
  canMark,
  timezone,
}: {
  refunds: PaymentToRefund[];
  canMark: boolean;
  timezone: string;
}) {
  return (
    <Card className="mt-6 p-5">
      <h2 className="font-display text-lg font-semibold tracking-tight">
        Pagos a devolver
      </h2>
      <p className="mt-2 text-sm text-muted">
        Devolvelo desde tu cuenta de Mercado Pago y después marcalo acá. Si ya
        lo devolviste desde Mercado Pago, se marca solo.
      </p>
      <ul className="mt-4 space-y-2">
        {refunds.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-3"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{r.customerName}</p>
              <p className="text-sm text-muted">
                {format(new TZDate(r.startsAt, timezone), "d 'de' MMMM, HH:mm", { locale: es })}
                {" · "}
                {formatPrice(r.amountCents, r.currency)}
              </p>
              {r.mpPaymentId && (
                <p className="text-xs text-faint">Pago de Mercado Pago {r.mpPaymentId}</p>
              )}
            </div>
            {canMark && (
              <form action={markPaymentRefundedAction}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                  Marcar como devuelto
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PaymentsBody({
  eligible,
  isOwner,
  enabled,
  account,
  timezone,
}: {
  eligible: boolean;
  isOwner: boolean;
  enabled: boolean;
  account: { status: "connected" | "broken"; connectedAt: string } | null;
  timezone: string;
}) {
  const broken = account?.status === "broken";
  const connected = account?.status === "connected";

  if (!eligible) {
    return (
      <>
        <Card className="mt-6 p-5">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            No incluido en tu plan
          </h2>
          <p className="mt-2 text-sm text-muted">
            Los pagos online están disponibles en los planes Pro y Premium.
            Con tu plan actual tus clientes reservan sin pagar.
          </p>
          <Link
            href="/panel/suscripcion"
            className={buttonClasses({ variant: "primary", size: "md", className: "mt-4" })}
          >
            Ver planes
          </Link>
        </Card>

        {/* Un negocio que bajó de plan con los pagos prendidos tiene que poder
            dejarlos limpios: apagar se permite siempre, también en la base. */}
        {enabled && isOwner && (
          <Card className="mt-4 p-5">
            <p className="text-sm text-muted">
              Quedaron prendidos desde antes de cambiar de plan.
            </p>
            <ToggleForm enable={false} />
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      {/* CONEXIÓN */}
      <Card className="mt-6 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Cuenta de Mercado Pago
          </h2>
          {connected && <Badge variant="gold">Conectada</Badge>}
        </div>

        {broken ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              La conexión con Mercado Pago se rompió. Mientras no la
              reconectes, tus clientes reservan sin pagar.
            </span>
          </p>
        ) : connected ? (
          <p className="mt-2 text-sm text-muted">
            Conectada el{" "}
            {format(new TZDate(account.connectedAt, timezone), "d 'de' MMMM 'de' yyyy", {
              locale: es,
            })}
            .
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Todavía no conectaste tu cuenta. Vas a pasar por Mercado Pago para
            autorizarnos a crear cobros a tu nombre.
          </p>
        )}

        {isOwner ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {/* Un <a> plano y NO un <Link>: Link precarga la ruta al aparecer
                en pantalla, y precargar este endpoint planta la cookie del
                flujo y arranca una conexión que nadie pidió. */}
            <a
              href={CONNECT_HREF}
              className={buttonClasses({
                variant: connected ? "secondary" : "primary",
                size: "md",
              })}
            >
              {broken ? "Reconectar Mercado Pago" : connected ? "Volver a conectar" : "Conectar Mercado Pago"}
            </a>
            {account && (
              <form action={disconnectMpAction}>
                <button type="submit" className={buttonClasses({ variant: "danger", size: "md" })}>
                  Desconectar
                </button>
              </form>
            )}
          </div>
        ) : (
          <OwnerOnlyNote />
        )}
      </Card>

      {/* ACTIVACIÓN */}
      <Card className="mt-4 p-5">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          Cobrar al reservar
        </h2>
        <p className="mt-2 text-sm text-muted">
          {broken
            ? enabled
              ? "Los pagos siguen activados en tu cuenta, pero no cobran hasta que reconectes."
              : "Los pagos online están desactivados."
            : enabled
              ? "Los pagos online están activados: tus clientes pagan al reservar."
              : "Los pagos online están desactivados: tus clientes reservan sin pagar."}
        </p>
        <p className="mt-2 text-sm text-muted">
          Al activarlos, tus clientes pagan el precio completo del turno al
          reservar, y la plata va directo a tu cuenta de Mercado Pago. Si no
          pagan, el lugar se libera solo a los 15 minutos.
        </p>

        {isOwner && !broken && (
          <ToggleForm enable={!enabled} disabled={!enabled && !connected} />
        )}
        {/* Con la cuenta rota no se puede activar, pero apagar siempre se puede:
            la base lo permite y el dueño no tiene por qué reconectar para eso. */}
        {isOwner && broken && enabled && <ToggleForm enable={false} />}
        {isOwner && !connected && !enabled && !broken && (
          <p className="mt-2 text-xs text-faint">
            Conectá tu cuenta de Mercado Pago para poder activarlos.
          </p>
        )}
      </Card>
    </>
  );
}

function OwnerOnlyNote() {
  return (
    <p className="mt-4 text-sm text-faint">
      Sólo el dueño del negocio puede cambiar esto.
    </p>
  );
}

function ToggleForm({ enable, disabled = false }: { enable: boolean; disabled?: boolean }) {
  return (
    <form action={toggleOnlinePaymentsAction} className="mt-4">
      <input type="hidden" name="enabled" value={enable ? "true" : "false"} />
      <button
        type="submit"
        disabled={disabled}
        className={buttonClasses({ variant: enable ? "primary" : "secondary", size: "md" })}
      >
        {enable ? "Activar pagos online" : "Desactivar pagos online"}
      </button>
    </form>
  );
}
