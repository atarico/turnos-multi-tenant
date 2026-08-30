import type { PlanTier } from "@/modules/tenants/domain/types";

/**
 * Lo que cada plan habilita.
 *
 * `staff` es un límite de STOCK: cuenta lo que el negocio TIENE en este
 * momento. Los otros dos son de CONSUMO: cuentan lo que GASTÓ en el período
 * facturado y se resetean con cada cobro. La diferencia no es cosmética —
 * decide qué pasa al bajar de plan. Ver `hasRoomForStaff`.
 */
export interface PlanLimits {
  /** Profesionales activos simultáneos. Pausar uno libera su lugar. */
  staff: number;
  /** Mensajes de WhatsApp por período. Cero = el plan no incluye WhatsApp. */
  whatsappMessages: number;
  /**
   * Techo de turnos por período. Es un freno ANTI-ABUSO, no una palanca de
   * venta: está puesto tan alto que un negocio normal no lo toca, y llegar al
   * tope no bloquea la reserva de quien quiere sacar turno. Al que hay que
   * avisarle es al dueño, que es el que eligió el plan.
   */
  bookingsPerMonth: number;
}

/**
 * La única palanca de venta es la cantidad de profesionales. Podrían haberse
 * puesto cuatro perillas distintas; con una sola el cliente entiende en qué
 * plan cae con una sola pregunta: cuántos profesionales son.
 */
const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  basico: { staff: 2, whatsappMessages: 0, bookingsPerMonth: 300 },
  pro: { staff: 5, whatsappMessages: 800, bookingsPerMonth: 1500 },
  premium: { staff: 15, whatsappMessages: 2000, bookingsPerMonth: 5000 },
};

/**
 * El orden de los planes, de menos a más.
 *
 * Espeja la declaración del enum `public.plan_tier`, donde Postgres compara por
 * orden de declaración. Están escritos acá y no derivados de `PLAN_LIMITS`
 * porque el orden es una decisión de producto, no una consecuencia de los
 * números: si mañana un plan tuviera más profesionales pero menos WhatsApp,
 * derivarlo de los límites daría un orden distinto según qué límite se mire.
 */
const PLAN_RANK: Record<PlanTier, number> = {
  basico: 0,
  pro: 1,
  premium: 2,
};

/**
 * El mejor de dos planes.
 *
 * Existe para que un regalo nunca empeore lo comprado: ver `effectivePlan`.
 * Ante un plan que no está en el catálogo prefiere el otro, con el mismo
 * criterio de `limitsFor` — pero sin romper, porque acá siempre hay una
 * respuesta segura disponible y romper dejaría al negocio sin ningún plan.
 */
export function betterPlan(a: PlanTier, b: PlanTier): PlanTier {
  const rankA = Object.hasOwn(PLAN_RANK, a) ? PLAN_RANK[a] : -1;
  const rankB = Object.hasOwn(PLAN_RANK, b) ? PLAN_RANK[b] : -1;
  return rankB > rankA ? b : a;
}

/**
 * Límites del plan, o error si el plan no está en el catálogo.
 *
 * `PlanTier` es una unión de TypeScript y el valor real sale de una columna de
 * la base: si alguien agrega un valor al enum de Postgres sin tocar esta
 * tabla, el compilador no se entera. Un lookup pelado devolvería `undefined` y
 * `hasRoomForStaff` reventaría con un TypeError sobre `.staff`, lejos de la
 * causa. Mejor romper acá, con el nombre del plan en el mensaje.
 */
export function limitsFor(plan: PlanTier): PlanLimits {
  // `Object.hasOwn` y no `=== undefined`: un objeto literal hereda de
  // `Object.prototype`, así que una clave como `toString` devolvía una FUNCIÓN
  // en vez de `undefined`, el guard la dejaba pasar, y `hasRoomForStaff`
  // terminaba leyendo `.staff` sobre ella y respondiendo `false` en silencio
  // — justo lo contrario de romper fuerte.
  if (!Object.hasOwn(PLAN_LIMITS, plan)) {
    throw new Error(`Plan sin límites en el catálogo: ${plan}`);
  }
  return PLAN_LIMITS[plan];
}

/**
 * Cómo se llama cada plan para una persona.
 *
 * Vive acá y no en la UI porque el primer lugar donde se lee no es una pantalla
 * nuestra: es el resumen de la tarjeta del dueño, meses después, cuando no se
 * acuerda qué contrató. Un renglón que diga sólo "Turnos" es un reclamo al
 * banco esperando a pasar.
 */
const PLAN_LABELS: Record<PlanTier, string> = {
  basico: "Básico",
  pro: "Pro",
  premium: "Premium",
};

/** Nombre visible del plan, o error si no está en el catálogo. */
export function planLabel(plan: PlanTier): string {
  // Mismo guard que `limitsFor`, por el mismo motivo: una clave heredada como
  // `toString` devuelve una función, no `undefined`.
  if (!Object.hasOwn(PLAN_LABELS, plan)) {
    throw new Error(`Plan sin nombre en el catálogo: ${plan}`);
  }
  return PLAN_LABELS[plan];
}

/**
 * ¿Entra un profesional más?
 *
 * Devuelve `false` tanto al tocar el límite como estando por encima. Ese
 * segundo caso no es un error de datos: es exactamente lo que queda cuando un
 * negocio con 7 profesionales baja a Básico. En esa situación NO se le borra
 * a nadie —perder gente cargada por un problema de plan sería inaceptable—,
 * simplemente deja de poder agregar hasta volver a estar debajo del tope.
 *
 * Y tiene una salida propia sin pedir permiso a nadie: pausar a alguien libera
 * su lugar, porque el conteo mira sólo profesionales activos.
 */
export function hasRoomForStaff(plan: PlanTier, activeStaff: number): boolean {
  return activeStaff < limitsFor(plan).staff;
}

/**
 * ¿Ya se pasó del límite?
 *
 * Parece la negación de `hasRoomForStaff` y no lo es: estar JUSTO en el tope
 * es no tener lugar, pero no es haberse pasado. La diferencia importa para la
 * UI — al que está lleno se le ofrece subir de plan; al que quedó por encima
 * tras una degradación hay que avisarle que algo se le va a trabar.
 */
export function isOverStaffLimit(plan: PlanTier, activeStaff: number): boolean {
  return activeStaff > limitsFor(plan).staff;
}
