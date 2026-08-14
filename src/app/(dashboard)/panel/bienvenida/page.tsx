import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CalendarCheck, Link2, Scissors, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getCurrentUserName } from "@/modules/auth/application/queries";
import { getCurrentTenant } from "@/modules/tenants/application/queries";
import { OnboardingForm } from "@/modules/tenants/ui/onboarding-form";

export const metadata: Metadata = { title: "Bienvenida" };

const PROMISES = [
  {
    icon: Link2,
    text: "Un link propio para compartir por WhatsApp o Instagram.",
  },
  {
    icon: CalendarCheck,
    text: "Las reservas entran solas en tu agenda, sin ida y vuelta.",
  },
  {
    icon: Scissors,
    text: "Servicios y profesionales se cargan después, desde el panel.",
  },
];

export default async function WelcomePage() {
  // Las dos consultas son independientes: van en paralelo.
  const [tenant, name] = await Promise.all([
    getCurrentTenant(),
    getCurrentUserName(),
  ]);

  // Guard de ruta: un negocio ya creado no tiene nada que hacer acá.
  if (tenant) redirect("/panel");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center gap-16 px-6 py-12">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_0.85fr] lg:gap-14">
        {/* Columna editorial: el porqué */}
        <div className="flex flex-col items-start">
          <div className="animate-rise">
            <Badge variant="gold">
              <Sparkles className="size-3.5" />
              Último paso
            </Badge>
          </div>

          <h1
            className="animate-rise mt-6 font-display text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl"
            style={{ animationDelay: "80ms" }}
          >
            Te damos la bienvenida
            {name ? (
              <>
                , <span className="text-gold">{name}</span>
              </>
            ) : null}
            .
          </h1>

          <p
            className="animate-rise mt-5 max-w-md text-lg leading-relaxed text-muted"
            style={{ animationDelay: "160ms" }}
          >
            Creá tu negocio y te generamos tu link público de reservas.
            Compartilo y ya podés empezar a recibir turnos.
          </p>

          <ul
            className="animate-rise mt-8 space-y-3 text-sm text-faint"
            style={{ animationDelay: "240ms" }}
          >
            {PROMISES.map((promise) => (
              <li key={promise.text} className="flex items-start gap-3">
                <promise.icon className="mt-0.5 size-4 shrink-0 text-gold-dim" />
                {promise.text}
              </li>
            ))}
          </ul>
        </div>

        {/* Columna formulario: el foco */}
        <div
          className="animate-rise relative w-full"
          style={{ animationDelay: "200ms" }}
        >
          {/* halo dorado detrás de la card, igual que el hero público */}
          <div className="animate-glow absolute -inset-6 -z-10 rounded-full bg-gold/15 blur-3xl" />

          <Card className="p-6 sm:p-8">
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Creá tu negocio
            </h2>
            <p className="mt-1 text-sm text-muted">
              Con estos dos datos alcanza. Podés cambiarlos más adelante.
            </p>
            <div className="mt-6">
              <OnboardingForm />
            </div>
          </Card>
        </div>
      </section>
    </main>
  );
}
