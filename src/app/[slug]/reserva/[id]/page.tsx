import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card } from "@/components/ui/card";
import { PublicHeader } from "@/modules/booking/ui/public-header";
import { getBookingForReturn } from "@/modules/payments/application/booking-return";
import { returnState, type ReturnState } from "@/modules/payments/domain/return-state";
import { getTenantBySlug } from "@/modules/tenants/application/queries";

/**
 * Página de retorno de Mercado Pago, y también el link para consultar el turno
 * más tarde. Pública y anónima: el slug resuelve el negocio y el turno se busca
 * por id Y por ese negocio (ver `getBookingForReturn`).
 *
 * NO recibe `searchParams` a propósito. Mercado Pago agrega `status`,
 * `payment_id`, etc. a la URL de retorno, pero los puede escribir cualquiera:
 * lo que se muestra sale sólo de nuestra base. Si el pago ya se acreditó, el
 * webhook (T5) habrá confirmado el turno; si todavía no, esta pantalla dice que
 * se está confirmando.
 *
 * Es una página privada de una persona (el id es un uuid): fuera de los
 * buscadores.
 */
export const metadata: Metadata = {
  title: "Tu turno",
  robots: { index: false, follow: false },
};

interface ReturnPageProps {
  params: Promise<{ slug: string; id: string }>;
}

const MESSAGES: Record<ReturnState, { title: string; body?: string }> = {
  awaiting: {
    title: "Estamos confirmando tu pago…",
    body: "Puede tardar unos segundos. Si ya pagaste, actualizá en un momento.",
  },
  confirmed: { title: "¡Turno confirmado!" },
  released: {
    title: "El pago no se completó y el turno se liberó.",
    body: "Si querés, podés reservar de nuevo.",
  },
  other: { title: "Tu turno está registrado." },
};

export default async function BookingReturnPage({ params }: ReturnPageProps) {
  const { slug, id } = await params;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();

  const loaded = await getBookingForReturn(tenant.id, id);
  // Un id de otro negocio, mal formado o inexistente da lo mismo: 404.
  if (loaded.ok && !loaded.value) notFound();

  const refreshHref = `/${tenant.slug}/reserva/${id}`;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <PublicHeader
        name={tenant.name}
        logoUrl={tenant.logoUrl}
        brandColor={tenant.brandColor}
      />

      <Card className="mt-8 p-8 text-center" role="status">
        {!loaded.ok ? (
          <>
            <h2 className="font-display text-xl font-semibold tracking-tight">
              No pudimos consultar tu turno.
            </h2>
            <p className="mt-1 text-sm text-muted">Probá de nuevo en un momento.</p>
            <RefreshLink href={refreshHref} />
          </>
        ) : (
          <BookingStatus
            state={returnState(loaded.value!, new Date())}
            serviceName={loaded.value!.serviceName}
            startsAt={loaded.value!.startsAt}
            timezone={tenant.timezone}
            refreshHref={refreshHref}
            backHref={`/${tenant.slug}`}
          />
        )}
      </Card>
    </div>
  );
}

function BookingStatus({
  state,
  serviceName,
  startsAt,
  timezone,
  refreshHref,
  backHref,
}: {
  state: ReturnState;
  serviceName: string;
  startsAt: string;
  timezone: string;
  refreshHref: string;
  backHref: string;
}) {
  const message = MESSAGES[state];
  // El instante se cuenta desde la zona del NEGOCIO (el servidor corre en UTC).
  const when = format(new TZDate(new Date(startsAt), timezone), "EEEE d 'de' MMMM 'a las' HH:mm", {
    locale: es,
  });

  return (
    <>
      <h2 className="font-display text-xl font-semibold tracking-tight">{message.title}</h2>
      {message.body && <p className="mt-1 text-sm text-muted">{message.body}</p>}

      <div className="mx-auto mt-6 max-w-sm rounded-xl border border-border bg-surface-2 p-4 text-sm">
        <p className="font-medium text-foreground">{serviceName}</p>
        <p className="mt-1 capitalize text-muted">{when}</p>
      </div>

      {state === "awaiting" && <RefreshLink href={refreshHref} />}
      {state === "released" && (
        <a
          href={backHref}
          className="mt-6 inline-block text-sm font-medium text-gold underline-offset-4 hover:underline"
        >
          Reservar de nuevo
        </a>
      )}
    </>
  );
}

function RefreshLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="mt-6 inline-block text-sm font-medium text-gold underline-offset-4 hover:underline"
    >
      Actualizar
    </a>
  );
}
