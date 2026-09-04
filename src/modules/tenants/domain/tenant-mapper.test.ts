import { describe, expect, it } from "vitest";

import { toPublicTenant } from "./tenant-mapper";

describe("toPublicTenant", () => {
  it("maps a public_tenants row to camelCase, dropping panel-only fields", () => {
    const row = {
      id: "t1",
      slug: "acme-salon",
      name: "Acme Salon",
      timezone: "America/Argentina/Buenos_Aires",
      brand_color: "#0ea5e9",
      logo_url: "https://cdn.example.com/logo.png",
      takes_bookings: true,
    };

    expect(toPublicTenant(row)).toEqual({
      id: "t1",
      slug: "acme-salon",
      name: "Acme Salon",
      timezone: "America/Argentina/Buenos_Aires",
      brandColor: "#0ea5e9",
      logoUrl: "https://cdn.example.com/logo.png",
      takesBookings: true,
    });
  });

  it("maps a null logo_url to null", () => {
    const row = {
      id: "t2",
      slug: "otro-negocio",
      name: "Otro Negocio",
      timezone: "America/Santiago",
      brand_color: "#111111",
      logo_url: null,
      takes_bookings: true,
    };

    expect(toPublicTenant(row).logoUrl).toBeNull();
  });

  /**
   * El negocio que no toma turnos tiene que llegar como `false`, no como
   * "algo falsy": la página pública decide con este booleano si muestra el
   * formulario, y un `undefined` que se leyera como "no sé" terminaría
   * mostrándolo igual.
   */
  it("maps takes_bookings false through", () => {
    const row = {
      id: "t3",
      slug: "vencido",
      name: "Vencido",
      timezone: "UTC",
      brand_color: "#111111",
      logo_url: null,
      takes_bookings: false,
    };

    expect(toPublicTenant(row).takesBookings).toBe(false);
  });

  /**
   * Ante el dato AUSENTE —una migración sin aplicar, un `select` recortado, un
   * PostgREST que no devolvió la columna— se cierra, no se abre.
   *
   * Un `?? true` "para no romper la página" habría dejado tomando turnos
   * exactamente a los negocios sobre los que no sabemos nada, que es el caso en
   * el que menos hay que confiar. Y no hay riesgo de bloquear a alguien que
   * sí paga: `create_booking()` sigue siendo la que decide de verdad, así que
   * lo peor que hace un `false` de más es mostrar un cartel a destiempo.
   */
  it("a null takes_bookings closes the door, it does not open it", () => {
    const row = {
      id: "t4",
      slug: "sin-dato",
      name: "Sin Dato",
      timezone: "UTC",
      brand_color: "#111111",
      logo_url: null,
      takes_bookings: null,
    };

    expect(toPublicTenant(row).takesBookings).toBe(false);
  });
});
