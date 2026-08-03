"use client";

import { useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CircleCheckBig,
  Clock,
  Scissors,
  User,
} from "lucide-react";

import { type ActionState } from "@/core/action";
import { type Result } from "@/core/result";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/modules/catalog/domain/money";

import { customerSchema, type CustomerInput } from "../domain/schemas";
import type {
  AvailableSlot,
  BookableService,
  BookableStaff,
  WeeklyAvailability,
} from "../domain/types";
import { BookingCalendar } from "./booking-calendar";
import { CustomerForm } from "./customer-form";
import { SlotGrid } from "./slot-grid";

type Step = "service" | "staff" | "schedule" | "customer" | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "service", label: "Servicio" },
  { key: "staff", label: "Profesional" },
  { key: "schedule", label: "Fecha y hora" },
  { key: "customer", label: "Cliente" },
];

const EMPTY_CUSTOMER: CustomerInput = {
  customer_name: "",
  customer_email: "",
  customer_phone: "",
};

/**
 * Contrato de datos que el flujo necesita, inyectado por prop. El panel pasa
 * las Server Actions autenticadas (`actions.ts`); la página pública pasa las
 * anónimas (`public-actions.ts`) ya curriadas con su slug. El componente no
 * sabe de sesión ni de tenant: sólo orquesta los pasos y pinta el resultado.
 */
export interface BookingActions {
  listStaff(serviceId: string): Promise<Result<BookableStaff[]>>;
  getAvailability(
    staffId: string,
  ): Promise<Result<{ weekdays: number[]; windows: WeeklyAvailability[] }>>;
  getSlots(
    serviceId: string,
    staffId: string,
    dateStr: string,
  ): Promise<Result<AvailableSlot[]>>;
  createBooking(input: unknown): Promise<ActionState>;
}

interface BookingFlowProps {
  services: BookableService[];
  /** Timezone del negocio: el calendario la usa para calcular "hoy". */
  timezone: string;
  /** Origen de datos del flujo: panel (autenticado) o página pública (slug). */
  actions: BookingActions;
}

/** Instante ISO → "YYYY-MM-DD" en campos civiles locales (sin desfase de tz). */
function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Orquesta el alta manual de una reserva desde el panel: servicio →
 * profesional → fecha → franja → cliente → confirmar. Cada paso carga sus
 * datos vía Server Actions (que resuelven el negocio en el servidor). La
 * validación definitiva de cupo/horario la hace `create_booking()` al confirmar;
 * acá surfaceamos su error si la franja se ocupó mientras tanto.
 */
export function BookingFlow({ services, timezone, actions }: BookingFlowProps) {
  const [step, setStep] = useState<Step>("service");

  const [service, setService] = useState<BookableService | null>(null);
  const [staff, setStaff] = useState<BookableStaff | null>(null);
  const [date, setDate] = useState<Date | undefined>(undefined);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [customer, setCustomer] = useState<CustomerInput>(EMPTY_CUSTOMER);

  const [staffList, setStaffList] = useState<BookableStaff[]>([]);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [slots, setSlots] = useState<AvailableSlot[]>([]);

  const [staffLoading, setStaffLoading] = useState(false);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [stepError, setStepError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  async function chooseService(next: BookableService) {
    setService(next);
    setStaff(null);
    setStaffList([]);
    setWeekdays([]);
    setDate(undefined);
    setSlots([]);
    setSlot(null);
    setStepError(null);
    setStep("staff");

    setStaffLoading(true);
    const res = await actions.listStaff(next.id);
    setStaffLoading(false);
    if (!res.ok) {
      setStepError(res.error.message);
      return;
    }
    setStaffList(res.value);
  }

  async function chooseStaff(next: BookableStaff) {
    setStaff(next);
    setWeekdays([]);
    setDate(undefined);
    setSlots([]);
    setSlot(null);
    setStepError(null);
    setStep("schedule");

    setScheduleLoading(true);
    const res = await actions.getAvailability(next.id);
    setScheduleLoading(false);
    if (!res.ok) {
      setStepError(res.error.message);
      return;
    }
    setWeekdays(res.value.weekdays);
  }

  async function chooseDate(next: Date | undefined) {
    setDate(next);
    setSlot(null);
    setSlots([]);
    if (!next || !service || !staff) return;

    setSlotsLoading(true);
    const res = await actions.getSlots(service.id, staff.id, toDateStr(next));
    setSlotsLoading(false);
    if (!res.ok) {
      setStepError(res.error.message);
      return;
    }
    setSlots(res.value);
  }

  function chooseSlot(next: AvailableSlot) {
    setSlot(next);
    setFormErrors({});
    setStepError(null);
    setStep("customer");
  }

  async function confirm() {
    const parsed = customerSchema.safeParse(customer);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !fields[key]) fields[key] = issue.message;
      }
      setFormErrors(fields);
      return;
    }
    if (!service || !staff || !slot) return;

    setSubmitting(true);
    setStepError(null);
    const result = await actions.createBooking({
      service_id: service.id,
      staff_id: staff.id,
      starts_at: slot.startsAt,
      ...parsed.data,
    });
    setSubmitting(false);

    if (result.status === "error") {
      setStepError(result.message);
      setFormErrors(result.fieldErrors ?? {});
      return;
    }
    setStep("done");
  }

  function reset() {
    setStep("service");
    setService(null);
    setStaff(null);
    setStaffList([]);
    setWeekdays([]);
    setDate(undefined);
    setSlots([]);
    setSlot(null);
    setCustomer(EMPTY_CUSTOMER);
    setFormErrors({});
    setStepError(null);
  }

  if (step === "done") {
    return (
      <Confirmation
        service={service}
        staff={staff}
        slot={slot}
        date={date}
        customerName={customer.customer_name}
        onReset={reset}
      />
    );
  }

  const activeIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="space-y-6">
      <Stepper activeIndex={activeIndex} />

      {stepError && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {stepError}
        </p>
      )}

      {step === "service" && (
        <StepCard icon={<Scissors className="size-4" />} title="Elegí el servicio">
          {services.length === 0 ? (
            <p className="text-sm text-muted">
              Todavía no tenés servicios activos. Creá uno para poder reservar.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {services.map((s) => (
                <SelectableRow
                  key={s.id}
                  active={service?.id === s.id}
                  onClick={() => chooseService(s)}
                  title={s.name}
                  subtitle={`${s.durationMin} min · ${formatPrice(s.priceCents, s.currency)}${
                    s.capacity > 1 ? ` · hasta ${s.capacity} personas` : ""
                  }`}
                />
              ))}
            </div>
          )}
        </StepCard>
      )}

      {step === "staff" && (
        <StepCard
          icon={<User className="size-4" />}
          title="Elegí el profesional"
          onBack={() => setStep("service")}
        >
          {staffLoading ? (
            <LoadingRows />
          ) : staffList.length === 0 ? (
            <p className="text-sm text-muted">
              Ningún profesional ofrece este servicio todavía.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {staffList.map((st) => (
                <SelectableRow
                  key={st.id}
                  active={staff?.id === st.id}
                  onClick={() => chooseStaff(st)}
                  title={st.name}
                  subtitle={st.role ?? undefined}
                />
              ))}
            </div>
          )}
        </StepCard>
      )}

      {step === "schedule" && (
        <StepCard
          icon={<CalendarDays className="size-4" />}
          title="Elegí fecha y hora"
          onBack={() => setStep("staff")}
        >
          {scheduleLoading ? (
            <LoadingRows />
          ) : weekdays.length === 0 ? (
            <p className="text-sm text-muted">
              Este profesional no tiene disponibilidad cargada.
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
              <BookingCalendar
                selected={date}
                onSelect={chooseDate}
                weekdays={weekdays}
                timezone={timezone}
              />
              <div className="min-w-0 space-y-3">
                <p className="text-sm font-medium text-muted">
                  {date
                    ? format(date, "EEEE d 'de' MMMM", { locale: es })
                    : "Elegí un día en el calendario"}
                </p>
                {date && (
                  <SlotGrid
                    slots={slots}
                    selected={slot?.startsAt ?? null}
                    onSelect={chooseSlot}
                    loading={slotsLoading}
                  />
                )}
              </div>
            </div>
          )}
        </StepCard>
      )}

      {step === "customer" && (
        <StepCard
          icon={<Clock className="size-4" />}
          title="Datos del cliente"
          onBack={() => setStep("schedule")}
        >
          <Summary service={service} staff={staff} slot={slot} date={date} />
          <div className="mt-5">
            <CustomerForm
              values={customer}
              onChange={setCustomer}
              errors={formErrors}
            />
          </div>
          <Button
            className="mt-6 w-full"
            onClick={confirm}
            disabled={submitting}
          >
            {submitting ? "Confirmando…" : "Confirmar reserva"}
          </Button>
        </StepCard>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Subcomponentes de presentación
// ─────────────────────────────────────────────────────────────

function Stepper({ activeIndex }: { activeIndex: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {STEPS.map((s, i) => {
        const done = i < activeIndex;
        const current = i === activeIndex;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs font-semibold",
                done && "border-gold/40 bg-gold/15 text-gold",
                current && "border-gold bg-gold text-on-gold",
                !done && !current && "border-border text-faint",
              )}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              className={cn(
                "tracking-tight",
                current ? "text-foreground" : "text-muted",
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="mx-1 h-px w-5 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepCard({
  icon,
  title,
  onBack,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          <span className="text-gold">{icon}</span>
          {title}
        </h2>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Volver
          </button>
        )}
      </div>
      {children}
    </Card>
  );
}

function SelectableRow({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        active
          ? "border-gold bg-gold/10"
          : "border-border bg-surface-2 hover:border-gold/40 hover:bg-elevated",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">{title}</span>
        {subtitle && (
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        )}
      </span>
      {active && <Check className="size-4 shrink-0 text-gold" />}
    </button>
  );
}

function Summary({
  service,
  staff,
  slot,
  date,
}: {
  service: BookableService | null;
  staff: BookableStaff | null;
  slot: AvailableSlot | null;
  date: Date | undefined;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4 text-sm">
      <SummaryRow label="Servicio" value={service?.name} />
      <SummaryRow label="Profesional" value={staff?.name} />
      <SummaryRow
        label="Fecha"
        value={date ? format(date, "EEEE d 'de' MMMM", { locale: es }) : undefined}
      />
      <SummaryRow label="Hora" value={slot?.label} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-muted">{label}</span>
      <span className="truncate font-medium capitalize text-foreground">
        {value ?? "—"}
      </span>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-xl border border-border bg-surface-2"
        />
      ))}
    </div>
  );
}

function Confirmation({
  service,
  staff,
  slot,
  date,
  customerName,
  onReset,
}: {
  service: BookableService | null;
  staff: BookableStaff | null;
  slot: AvailableSlot | null;
  date: Date | undefined;
  customerName: string;
  onReset: () => void;
}) {
  return (
    <Card className="p-8 text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-gold/30 bg-gold/10 text-gold">
        <CircleCheckBig className="size-7" />
      </div>
      <h2 className="mt-4 font-display text-xl font-semibold tracking-tight">
        Reserva confirmada
      </h2>
      <p className="mt-1 text-sm text-muted">
        El turno de {customerName || "el cliente"} quedó registrado.
      </p>

      <div className="mx-auto mt-6 max-w-sm text-left">
        <Summary service={service} staff={staff} slot={slot} date={date} />
      </div>

      <Button className="mt-6" onClick={onReset}>
        Cargar otra reserva
      </Button>
    </Card>
  );
}
