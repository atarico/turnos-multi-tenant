import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck,
  Clock,
  CreditCard,
  MessageCircle,
  Scissors,
  Send,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const STEPS = [
  {
    icon: Scissors,
    title: "Creá tus servicios",
    description: "Cargá lo que ofrecés, cuánto dura y cuánto cobrás.",
  },
  {
    icon: Send,
    title: "Compartí tu link",
    description: "Un link propio, el mismo que ven tus clientes al reservar.",
  },
  {
    icon: CalendarCheck,
    title: "Recibí tus turnos",
    description: "Se acomodan solos en tu agenda, sin ida y vuelta.",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6">
      {/* ── Nav ── */}
      <header className="flex items-center justify-between py-6">
        <span className="font-display text-xl font-semibold tracking-tight">
          Turnos<span className="text-gold">.</span>
        </span>
        <nav className="flex items-center gap-2">
          <Link href="/ingresar">
            <Button variant="ghost" size="sm">
              Ingresar
            </Button>
          </Link>
          <Link href="/registro">
            <Button size="sm">Crear mi negocio</Button>
          </Link>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-8">
        {/* Columna texto */}
        <div className="flex flex-col items-start">
          <div className="animate-rise">
            <Badge variant="gold">
              <Sparkles className="size-3.5" />
              SaaS de reservas para profesionales
            </Badge>
          </div>

          <h1
            className="animate-rise mt-6 font-display text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl"
            style={{ animationDelay: "80ms" }}
          >
            Tu agenda <span className="text-gold">llena</span>,
            <br />
            sin mover un dedo.
          </h1>

          <p
            className="animate-rise mt-6 max-w-md text-lg leading-relaxed text-muted"
            style={{ animationDelay: "160ms" }}
          >
            Calendario inteligente, cobros con Mercado Pago y Stripe, y
            recordatorios automáticos por WhatsApp. Tus clientes reservan solos,
            vos cobrás antes del turno.
          </p>

          <div
            className="animate-rise mt-8 flex flex-wrap items-center gap-3"
            style={{ animationDelay: "240ms" }}
          >
            <Link href="/registro">
              <Button size="lg">
                Crear mi negocio
                <ArrowRight className="size-4" />
              </Button>
            </Link>
            <Link href="#como-funciona">
              <Button variant="outline" size="lg">
                Ver cómo funciona
              </Button>
            </Link>
          </div>

          <div
            className="animate-rise mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm text-faint"
            style={{ animationDelay: "320ms" }}
          >
            <span className="inline-flex items-center gap-2">
              <CreditCard className="size-4 text-gold-dim" />
              Mercado Pago &amp; Stripe
            </span>
            <span className="inline-flex items-center gap-2">
              <MessageCircle className="size-4 text-gold-dim" />
              Recordatorios por WhatsApp
            </span>
            <span className="inline-flex items-center gap-2">
              <CalendarCheck className="size-4 text-gold-dim" />
              Multi-negocio
            </span>
          </div>
        </div>

        {/* Columna visual: preview de un turno */}
        <div
          className="animate-rise relative"
          style={{ animationDelay: "200ms" }}
        >
          {/* halo dorado detrás de la card */}
          <div className="animate-glow absolute -inset-6 -z-10 rounded-full bg-gold/15 blur-3xl" />

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted">
                Próximo turno
              </span>
              <Badge variant="success">Confirmado</Badge>
            </div>

            <div className="mt-5 flex items-center gap-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-gold/15 font-display text-lg font-semibold text-gold">
                MR
              </div>
              <div>
                <p className="font-medium text-foreground">Martina Ríos</p>
                <p className="text-sm text-muted">Corte &amp; color</p>
              </div>
            </div>

            <div className="mt-5 flex items-center gap-4 border-t border-border pt-5 text-sm">
              <span className="inline-flex items-center gap-2 text-foreground">
                <Clock className="size-4 text-gold" />
                Hoy, 15:30
              </span>
              <span className="ml-auto font-display text-lg font-semibold text-gold">
                $8.500
              </span>
            </div>
          </Card>

          {/* mini fila de disponibilidad */}
          <Card className="mt-4 flex items-center gap-2 p-4">
            {["09:00", "11:30", "15:30", "17:00"].map((h) => (
              <span
                key={h}
                className={
                  h === "15:30"
                    ? "flex-1 rounded-lg bg-gold py-2 text-center text-sm font-medium text-on-gold"
                    : "flex-1 rounded-lg bg-surface-2 py-2 text-center text-sm text-muted"
                }
              >
                {h}
              </span>
            ))}
          </Card>
        </div>
      </section>

      {/* ── Cómo funciona ── */}
      <section id="como-funciona" className="border-t border-border py-16">
        <div className="animate-rise text-center">
          <Badge variant="gold">Así de simple</Badge>
          <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Cómo funciona
          </h2>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <Card
              key={step.title}
              data-step
              className="animate-rise p-6"
              style={{ animationDelay: `${i * 120}ms` }}
            >
              <span className="font-display text-4xl font-semibold text-gold">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="mt-4 flex items-center gap-2 text-foreground">
                <step.icon className="size-5 text-gold-dim" />
                <h3 className="font-medium tracking-tight">{step.title}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {step.description}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-6 text-sm text-faint">
        Hecho para profesionales que valoran su tiempo.
      </footer>
    </main>
  );
}
