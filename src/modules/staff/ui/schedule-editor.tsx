"use client";

import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { type ActionState, idleState } from "@/core/action";

import { type ScheduleWindow, WEEKDAYS } from "../domain/schedule";

interface ScheduleEditorProps {
  /** Viaja en el form; que el profesional sea del negocio lo valida la action. */
  staffId: string;
  windows: ScheduleWindow[];
  save: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}

/** Franja en edición. El `key` es local: la base no lo conoce ni le importa. */
interface EditableWindow extends ScheduleWindow {
  key: string;
}

/** Horario que se propone al agregar un día: mañana de trabajo típica. */
const DEFAULT_WINDOW = { startTime: "09:00", endTime: "13:00" };

/**
 * Editor del horario semanal de un profesional.
 *
 * Se guarda la semana ENTERA de una, no franja por franja: "el horario de Ana"
 * es una sola cosa, y editarlo de a pedazos deja estados intermedios (un día
 * sin franjas a mitad de camino) que no significan nada para el negocio.
 *
 * Los `<input>` son NO controlados a propósito: el estado sólo lleva qué filas
 * existen, y los valores los lee el FormData del DOM al enviar. Por eso la
 * `key` tiene que ser estable — con el índice, borrar una fila del medio le
 * correría los valores tipeados a las de abajo.
 */
export function ScheduleEditor({ staffId, windows, save }: ScheduleEditorProps) {
  const [state, action, pending] = useActionState(save, idleState);
  const [rows, setRows] = useState<EditableWindow[]>(() =>
    windows.map((w, index) => ({ ...w, key: `initial-${index}` })),
  );

  const addWindow = (weekday: number) =>
    setRows((current) => [
      ...current,
      { ...DEFAULT_WINDOW, weekday, key: crypto.randomUUID() },
    ]);

  const removeWindow = (key: string) =>
    setRows((current) => current.filter((row) => row.key !== key));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="staffId" value={staffId} />

      {state.status === "error" && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.status === "success" && state.message && (
        <p className="rounded-xl border border-success/30 bg-success/10 px-3.5 py-2.5 text-sm text-success">
          {state.message}
        </p>
      )}

      {WEEKDAYS.map((day) => {
        const dayRows = rows.filter((row) => row.weekday === day.value);
        return (
          <Card
            key={day.value}
            role="group"
            aria-label={day.label}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <p className="w-28 shrink-0 pt-2 font-medium text-foreground">
              {day.label}
            </p>

            <div className="flex-1 space-y-2">
              {dayRows.length === 0 ? (
                <p className="pt-2 text-sm text-muted">Cerrado</p>
              ) : (
                dayRows.map((row) => (
                  <div key={row.key} className="flex items-center gap-2">
                    <input type="hidden" name="weekday" value={row.weekday} />
                    <TimeField
                      label="Desde"
                      name="startTime"
                      defaultValue={row.startTime}
                    />
                    <span className="text-muted">→</span>
                    <TimeField
                      label="Hasta"
                      name="endTime"
                      defaultValue={row.endTime}
                    />
                    <button
                      type="button"
                      aria-label="Quitar franja"
                      onClick={() => removeWindow(row.key)}
                      className="rounded-lg p-2 text-muted transition-colors hover:bg-surface hover:text-danger"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))
              )}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Agregar franja el ${day.label}`}
              onClick={() => addWindow(day.value)}
            >
              <Plus className="size-4" />
              Franja
            </Button>
          </Card>
        );
      })}

      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar horario"}
      </Button>
    </form>
  );
}

function TimeField({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue: string;
}) {
  return (
    <input
      type="time"
      name={name}
      aria-label={label}
      defaultValue={defaultValue}
      className="h-10 rounded-xl border border-border bg-surface-2 px-3 text-sm text-foreground focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/15"
    />
  );
}
