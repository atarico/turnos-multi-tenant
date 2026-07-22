/**
 * Servicio visto desde el PANEL (gestión del catálogo).
 *
 * Es distinto de `BookableService` del módulo booking: aquel es la vista de
 * quien reserva (sólo servicios activos, sin flag), este es la del dueño, que
 * necesita ver y tocar también los inactivos.
 */
export interface CatalogService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  currency: string;
  capacity: number;
  active: boolean;
}
