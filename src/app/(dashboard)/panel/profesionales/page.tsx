import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Scissors } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import {
  hasRoomForStaff,
  isOverStaffLimit,
  limitsFor,
  planLabel,
} from "@/modules/billing/domain/plan";
import { listCatalogServices } from "@/modules/catalog/application/queries";
import {
  deleteStaffAction,
  saveStaffAction,
  toggleStaffActiveAction,
} from "@/modules/staff/application/actions";
import { listStaffMembers } from "@/modules/staff/application/queries";
import { StaffManager } from "@/modules/staff/ui/staff-manager";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

export const metadata: Metadata = { title: "Profesionales" };

export default async function StaffPage() {
  const tenant = await getCurrentTenant();
  // Sin negocio no hay equipo: el panel decide a dónde mandarlo.
  if (!tenant) redirect("/panel");

  // Las dos consultas son independientes: van en paralelo.
  const [staffResult, servicesResult] = await Promise.all([
    listStaffMembers(tenant.id),
    listCatalogServices(tenant.id),
  ]);

  const members = staffResult.ok ? staffResult.value : [];
  const services = servicesResult.ok ? servicesResult.value : [];
  const error = !staffResult.ok
    ? staffResult.error.message
    : !servicesResult.ok
      ? servicesResult.error.message
      : null;

  /**
   * Los activos se cuentan de la MISMA lista que se pinta abajo, y no con una
   * consulta aparte.
   *
   * No es por ahorrar una ida a la base: es para que el número del aviso y la
   * lista no puedan discrepar. Contándolo en Postgres, cualquier diferencia
   * entre las dos lecturas —una consulta que falla, un recorte— dejaría al
   * dueño mirando "tenés 3 activos" arriba de una lista donde cuenta 2.
   *
   * `null` cuando la lectura falló, y NO cero: `members` cae a `[]` para poder
   * pintar la pantalla, pero esa lista vacía no es una respuesta. Decirle "0 de
   * 2 activos" al que no pudimos leer es inventarle un estado tranquilo.
   */
  const activeStaff = staffResult.ok
    ? staffResult.value.filter((m) => m.active).length
    : null;
  const staffLimit = limitsFor(tenant.plan).staff;
  // El plan EFECTIVO, cortesía incluida: el que tiene premium de regalo tiene
  // los 15 lugares de premium, y es contra ésos que hay que medirlo. Es el
  // mismo `tenant.plan` que mira el guard del alta, así que el aviso y el
  // bloqueo no pueden decir cosas distintas.
  const overStaffLimit =
    activeStaff !== null && isOverStaffLimit(tenant.plan, activeStaff);
  const roomForStaff =
    activeStaff !== null && hasRoomForStaff(tenant.plan, activeStaff);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/panel"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            <ArrowLeft className="size-4" />
            Volver al panel general
          </Link>
          <Link
            href="/panel/servicios"
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            <Scissors className="size-4" />
            Servicios
          </Link>
        </div>
        <h1 className="mt-4 font-display text-2xl font-semibold tracking-tight">
          Profesionales
        </h1>
        <p className="mt-1 text-sm text-muted">
          Quién atiende y qué presta cada uno. Sin al menos un profesional con
          servicios asignados, tu página pública no tiene nada para ofrecer.
        </p>
      </header>

      {error && (
        <p className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      {/* EL CUPO SE AVISA ACÁ, NO EN EL ERROR DEL ALTA.
          El que bajó de plan y quedó por encima del tope no rompió ninguna
          regla, y no se le borra a nadie. Pero su próxima alta se traba, y
          hasta hoy se enteraba recién ahí: cargaba el formulario entero para
          que la pantalla le contestara que no. Los tres estados dicen cosas
          distintas a propósito — estar LLENO es no tener lugar, estar POR
          ENCIMA es haber quedado con gente que ya no entra, y a ése hay que
          decirle antes que nada que no le sacamos a nadie. */}
      {activeStaff !== null && (
        <p
          data-staff-quota=""
          className={
            roomForStaff
              ? "mt-6 text-sm text-muted"
              : "mt-6 rounded-xl border border-gold/30 bg-gold/10 px-3.5 py-3 text-sm text-foreground"
          }
        >
          {overStaffLimit ? (
            <>
              Tenés <b>{activeStaff}</b> profesionales activos y tu plan{" "}
              {planLabel(tenant.plan)} permite {staffLimit}.{" "}
              <b>No sacamos a nadie</b>: siguen todos como están. Pero hasta
              volver a {staffLimit} no vas a poder sumar ni reactivar a nadie.
              Pausar a alguien libera su lugar.{" "}
            </>
          ) : roomForStaff ? (
            <>
              Tenés <b>{activeStaff}</b> de {staffLimit} profesionales activos
              en tu plan {planLabel(tenant.plan)}.
            </>
          ) : (
            <>
              Llegaste al tope de tu plan {planLabel(tenant.plan)}:{" "}
              <b>{activeStaff}</b> de {staffLimit} profesionales activos. Para
              sumar otro, pausá a alguno que no estés usando.{" "}
            </>
          )}
          {/* Sólo cuando hay algo que resolver. Ofrecerle un plan más grande
              al que va holgado es venderle lo que no necesita. */}
          {!roomForStaff && (
            <Link
              href="/panel/suscripcion"
              className="font-medium underline underline-offset-2"
            >
              Cambiar de plan
            </Link>
          )}
        </p>
      )}

      <div className="mt-8">
        <StaffManager
          members={members}
          services={services}
          actions={{
            save: saveStaffAction,
            toggleActive: toggleStaffActiveAction,
            remove: deleteStaffAction,
          }}
        />
      </div>
    </div>
  );
}
