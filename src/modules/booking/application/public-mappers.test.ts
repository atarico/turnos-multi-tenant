import { describe, expect, it } from "vitest";

import {
  toPublicLoad,
  toPublicService,
  toPublicStaff,
  toPublicAvailability,
} from "./public-mappers";

/**
 * Mapeos row→dominio de las vistas públicas. Funciones PURAS: sin import de
 * Supabase, testeables con fixtures planos y sin mocks — este es el punto
 * exacto donde un rename de columna en la vista rompe en silencio.
 */

describe("toPublicService", () => {
  it("maps a public_services row to BookableService", () => {
    const row = {
      id: "s1",
      tenant_id: "t1",
      name: "Corte",
      description: "Corte de pelo",
      duration_min: 30,
      price_cents: 500000,
      currency: "ARS",
      capacity: 1,
    };

    expect(toPublicService(row)).toEqual({
      id: "s1",
      name: "Corte",
      description: "Corte de pelo",
      durationMin: 30,
      priceCents: 500000,
      currency: "ARS",
      capacity: 1,
    });
  });

  it("maps a null description to null", () => {
    const row = {
      id: "s2",
      tenant_id: "t1",
      name: "Clase grupal",
      description: null,
      duration_min: 60,
      price_cents: 300000,
      currency: "ARS",
      capacity: 8,
    };

    expect(toPublicService(row).description).toBeNull();
  });
});

describe("toPublicStaff", () => {
  it("maps a public_staff row to BookableStaff", () => {
    const row = {
      id: "st1",
      tenant_id: "t1",
      name: "Juana Pérez",
      role: "Estilista",
      avatar_url: "https://cdn.example.com/juana.png",
    };

    expect(toPublicStaff(row)).toEqual({
      id: "st1",
      name: "Juana Pérez",
      role: "Estilista",
      avatarUrl: "https://cdn.example.com/juana.png",
    });
  });

  it("maps null role and avatar_url to null", () => {
    const row = {
      id: "st2",
      tenant_id: "t1",
      name: "Sin Foto",
      role: null,
      avatar_url: null,
    };

    const staff = toPublicStaff(row);
    expect(staff.role).toBeNull();
    expect(staff.avatarUrl).toBeNull();
  });
});

describe("toPublicAvailability", () => {
  it("maps a public_availability row to WeeklyAvailability", () => {
    const row = {
      staff_id: "st1",
      weekday: 2,
      start_time: "09:00:00",
      end_time: "17:00:00",
    };

    expect(toPublicAvailability(row)).toEqual({
      weekday: 2,
      startTime: "09:00:00",
      endTime: "17:00:00",
    });
  });
});

describe("toPublicLoad", () => {
  it("maps a public_booking_load row to BookingLoad", () => {
    const row = {
      staff_id: "st1",
      service_id: "s1",
      starts_at: "2026-09-13T13:00:00.000Z",
      ends_at: "2026-09-13T13:30:00.000Z",
    };

    expect(toPublicLoad(row)).toEqual({
      serviceId: "s1",
      startsAt: "2026-09-13T13:00:00.000Z",
      endsAt: "2026-09-13T13:30:00.000Z",
    });
  });
});
