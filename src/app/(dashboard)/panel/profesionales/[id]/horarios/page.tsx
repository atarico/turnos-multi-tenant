import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { saveScheduleAction } from "@/modules/staff/application/actions";
import {
  getStaffMember,
  getStaffSchedule,
} from "@/modules/staff/application/queries";
import { ScheduleEditor } from "@/modules/staff/ui/schedule-editor";
import { getCurrentTenant } from "@/modules/tenants/application/queries";

interface SchedulePageProps {
  /** En este Next los params son una Promise: hay que esperarlos. */
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: SchedulePageProps): Promise<Metadata> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { title: "Horarios" };

  const { id } = await params;
  const member = await getStaffMember(tenant.id, id);
  return { title: member.ok ? `Horarios de ${member.value.name}` : "Horarios" };
}

export default async function SchedulePage({ params }: SchedulePageProps) {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect("/panel");

  const { id } = await params;
  // El id sale de la URL: `getStaffMember` filtra por tenant, así que un
  // profesional de otro negocio es un 404, no un horario ajeno.
  const member = await getStaffMember(tenant.id, id);
  if (!member.ok) notFound();

  const schedule = await getStaffSchedule(id);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header>
        <Link
          href="/panel/profesionales"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Profesionales
        </Link>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">
          Horarios de {member.value.name}
        </h1>
        <p className="mt-1 text-sm text-muted">
          Las horas son las de tu negocio ({tenant.timezone}). Los días sin
          franjas quedan cerrados y no ofrecen turnos.
        </p>
      </header>

      <div className="mt-8">
        {!schedule.ok ? (
          <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {schedule.error.message}
          </p>
        ) : (
          <ScheduleEditor
            staffId={id}
            windows={schedule.value}
            save={saveScheduleAction}
          />
        )}
      </div>
    </div>
  );
}
