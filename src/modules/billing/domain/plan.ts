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

export function limitsFor(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan];
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
