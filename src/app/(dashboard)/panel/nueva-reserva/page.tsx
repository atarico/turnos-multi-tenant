import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import {
  createBookingAction,
  getAvailabilityAction,
  getSlotsAction,
  listStaffAction,
} from "@/modules/booking/application/actions";
import { listServices } from "@/modules/booking/application/queries";
import {
  BookingFlow,
  type BookingActions,
} from "@/modules/booking/ui/booking-flow";
import { buttonClasses } from "@/components/ui/button";
import { getCurrentSubscription } from "@/modules/billing/application/queries";
import { takesNewBookings } from "@/modules/billing/domain/subscription";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

export const metadata: Metadata = { title: "Nueva reserva" };

// Camino autenticado: las acciones resuelven el negocio de la sesión en el
// servidor, así que el flujo las usa tal cual, sin slug.
const panelActions: BookingActions = {
  listStaff: listStaffAction,
  getAvailability: getAvailabilityAction,
  getSlots: getSlotsAction,
  createBooking: createBookingAction,
};

/**
 * El dueño se quedó sin plan y por eso no entran turnos nuevos.
 *
 * Contesta las tres preguntas en el orden en que se hacen: qué pasó, qué NO
 * pasó, y dónde se arregla. La segunda es la que importa — lo primero que
 * piensa alguien que no puede cargar un turno es que perdió la agenda, y su
 * agenda está entera: la sigue viendo, cerrando y reprogramando.
 *
 * No nombra la prueba, por lo mismo que `OWNER_BOOKING_RULES`: la prueba
 * vencida es una de las tres causas —están también la suscripción cancelada y
 * la ausencia de suscripción— y a quien canceló, hablarle de una prueba le
 * describe algo que no pasó.
 */
function NoActivePlanNotice() {
  return (
    <div className="rounded-xl border border-gold/30 bg-gold/10 px-5 py-5">
      <p className="text-sm font-medium text-foreground">
        Tu negocio no tiene un plan activo, así que por ahora no entran turnos
        nuevos.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Tu agenda no se tocó: los turnos que ya tenías siguen ahí, y los podés
        cerrar, cancelar o reprogramar como siempre. Lo único en pausa es cargar
        turnos nuevos, acá y en tu página pública.
      </p>
      <Link
        href="/panel/suscripcion"
        className={`${buttonClasses({ size: "sm" })} mt-4`}
      >
        Elegir un plan
      </Link>
    </div>
  );
}

export default async function NuevaReservaPage() {
  const tenant = await getCurrentTenant();

  // Sin negocio no hay agenda que cargar: el panel decide a dónde mandarlo.
  if (!tenant) redirect("/panel");

  const [servicesResult, subscription] = await Promise.all([
    listServices(tenant.id),
    getCurrentSubscription(tenant.id),
  ]);
  const services = servicesResult.ok ? servicesResult.value : [];

  /**
   * Se muestra el aviso SÓLO cuando se sabe que no hay plan, no cuando no se
   * sabe.
   *
   * `getCurrentSubscription` devuelve `null` tanto si el negocio no tiene
   * suscripción viva como si la base no contestó —lo dice su propia
   * documentación—, y esa diferencia acá importa: tratar el fallo de lectura
   * como "sin plan" le diría a un dueño que está al día que no tiene plan, y
   * le escondería un formulario que habría funcionado.
   *
   * HUECO CONOCIDO, precio de esa decisión: `getCurrentSubscription` filtra
   * por estados VIVOS, así que una suscripción CANCELADA también llega como
   * `null` y ese dueño ve el formulario; se entera al enviar. Se prefiere así
   * porque el error caro es el otro, y porque `create_booking()` lo rechaza
   * igual con el mismo mensaje que este cartel. Hay un test que lo fija.
   */
  const hasNoActivePlan =
    subscription !== null && !takesNewBookings(subscription, new Date());

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <Link
        href="/panel"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Volver al panel
      </Link>

      <header className="mt-4 mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Nueva reserva
        </h1>
        <p className="mt-1 text-sm text-muted">
          Cargá un turno manualmente para {tenant.name}.
        </p>
      </header>

      {hasNoActivePlan ? (
        <NoActivePlanNotice />
      ) : !servicesResult.ok ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {servicesResult.error.message}
        </p>
      ) : (
        <BookingFlow
          services={services}
          timezone={tenant.timezone}
          actions={panelActions}
        />
      )}
    </div>
  );
}
