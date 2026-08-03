/**
 * Profesional visto desde el PANEL (gestión).
 *
 * Es distinto de `BookableStaff` del módulo booking: aquel es la vista de quien
 * reserva (sólo activos, con avatar), este es la del dueño, que necesita ver
 * también los pausados y qué servicios presta cada uno.
 */
export interface StaffMember {
  id: string;
  name: string;
  /** Texto libre: "Peluquera", "Kinesiólogo"… */
  role: string | null;
  active: boolean;
  /** Servicios que este profesional presta (tabla `staff_services`). */
  serviceIds: string[];
}
