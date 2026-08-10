# Turnos Multi-tenant

SaaS de gestión de turnos para negocios de servicios. Cada negocio (tenant) administra su catálogo, sus profesionales y su agenda desde un panel privado, y recibe reservas desde una página pública propia en `/{slug}`.

## Funcionalidades

- **Multi-tenant con aislamiento por RLS**: cada tenant solo ve sus datos; las políticas viven en la base (Supabase/Postgres), no en la aplicación.
- **Onboarding de negocio**: alta con slug único, país, zona horaria y moneda.
- **Catálogo de servicios**: CRUD con precio (siempre en centavos, nunca float), duración y capacidad por turno.
- **Profesionales y horarios**: CRUD de profesionales, asignación de servicios y editor de agenda semanal con reemplazo atómico.
- **Motor de turnos**:
  - Cálculo de slots disponibles según agenda, capacidad y reservas existentes.
  - Anti doble-reserva con advisory locks en Postgres.
  - Ciclo de vida completo (pendiente → confirmado → completado / cancelado) con máquina de estados.
  - Reprogramación de turnos.
  - Precio congelado en la fila del turno al momento de reservar.
- **Página pública de reservas**: flujo anónimo por tenant en `/{slug}`, servido por vistas `public_*` de solo lectura, con freno anti-spam (tope de reservas por hora por origen, con la IP hasheada).
- **Panel con métricas**: turnos de hoy, próximo turno, turnos a cerrar e ingresos del mes (agregados en la base, resueltos en el mes civil de la zona horaria del tenant).

## Stack

| Área | Tecnología |
| --- | --- |
| Framework | Next.js 16 (App Router, Server Actions, `proxy.ts`) + React 19 |
| Backend | Supabase: Postgres + RLS, Auth, RPCs (`@supabase/supabase-js`, `@supabase/ssr`) |
| Lenguaje | TypeScript (strict) |
| Validación | Zod 4 |
| Estilos | Tailwind CSS 4 |
| Fechas | date-fns 4 + `@date-fns/tz` (zona horaria por tenant) |
| Tests | Vitest 4 + Testing Library |

No hay route handlers ni API REST propia: toda mutación entra por Server Actions y llega a la base vía RPCs de Postgres.

## Arquitectura

Módulos con capas explícitas, del estilo hexagonal:

```
src/
  app/            # Rutas (App Router): (auth), (dashboard)/panel, [slug] pública, landing
  core/           # Result<T, E>, AppError, ActionState para useActionState
  lib/            # env.ts (validado con Zod), clientes de Supabase, utilidades
  components/ui/  # Primitivas de UI (button, card, input, badge)
  modules/
    auth/         # Registro, ingreso, sesión
    tenants/      # Onboarding, slug, países/moneda, planes
    catalog/      # Servicios
    staff/        # Profesionales y horarios
    booking/      # Motor de turnos: domain/ + application/ + ui/
  proxy.ts        # Refresco de sesión de Supabase (middleware de Next 16)
```

Reglas que sostienen el diseño:

- `domain/` es TypeScript puro y concentra los tests unitarios; `application/` son Server Actions y queries; `ui/` son componentes React.
- El camino público (anónimo, de baja confianza) está separado del camino autenticado del panel: comparten solo el dominio puro.
- El dinero se maneja siempre como enteros en centavos.

## Puesta en marcha

Requisitos: Node.js 20+, pnpm y un proyecto de Supabase.

1. Instalar dependencias:

   ```bash
   pnpm install
   ```

2. Copiar `.env.example` a `.env.local` y completar las variables del proyecto de Supabase:

   | Variable | Descripción |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto de Supabase |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave anónima (pública) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Clave `service_role` (solo servidor, nunca expuesta al cliente) |
   | `NEXT_PUBLIC_APP_URL` | URL base de la app (default: `http://localhost:3000`) |
   | `BOOKING_IP_SALT` | Salt para hashear la IP del visitante en el freno anti-spam (mín. 16 caracteres) |

3. Aplicar las migraciones de `supabase/migrations/` al proyecto remoto:

   ```bash
   supabase db push
   ```

4. Levantar el entorno de desarrollo:

   ```bash
   pnpm dev
   ```

## Scripts

| Comando | Acción |
| --- | --- |
| `pnpm dev` | Servidor de desarrollo |
| `pnpm build` | Build de producción |
| `pnpm start` | Servir el build |
| `pnpm lint` | ESLint |
| `pnpm test` | Suite completa de tests (Vitest) |
| `pnpm test:watch` | Tests en modo watch |

## Tests

La suite corre en dos proyectos de Vitest:

- **domain**: entorno Node, tests puros de dominio (`*.test.ts`).
- **ui**: entorno jsdom con Testing Library (`*.test.tsx`).

## Base de datos

El esquema completo vive en `supabase/migrations/` (orden cronológico): schema inicial y enums, políticas RLS, motor de turnos, vistas públicas de solo lectura, editor de agenda, ciclo de vida y reprogramación, snapshot de precio e ingresos mensuales. Las funciones sensibles son RPCs con `SECURITY DEFINER` y grants explícitos.

## Roadmap

- **Pagos**: cobro de seña al reservar y suscripción del SaaS (Mercado Pago / Stripe, según país del tenant).
- **Planes**: que `plan_tier` limite funcionalidades y se facture.
- **Notificaciones**: recordatorios por WhatsApp.
- **Infraestructura**: CI (lint + typecheck + tests + build) y configuración de deploy.

## Notas de deploy

El freno anti-spam identifica al visitante por su IP tomada de `x-forwarded-for`. Eso es confiable detrás de un proxy que reescriba ese header (por ejemplo Vercel). En un deploy self-hosted sin ese proxy, el header es falsificable y el freno se puede evadir: en ese caso hay que anteponer un proxy de confianza.
