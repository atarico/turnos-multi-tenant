import { describe, expect, it } from "vitest";

import { resolveDayRange, resolveMonthRange } from "./day-range";

/** Horas entre dos instantes ISO. */
function spanHours(startIso: string, endIso: string): number {
  return (Date.parse(endIso) - Date.parse(startIso)) / 3_600_000;
}

describe("resolveDayRange", () => {
  it("returns the civil day boundaries as UTC ISO instants", () => {
    const range = resolveDayRange("2026-09-13", "America/Argentina/Buenos_Aires");

    expect(range).not.toBeNull();
    expect(range?.startIso).toBe("2026-09-13T03:00:00.000Z");
    expect(range?.endIso).toBe("2026-09-14T03:00:00.000Z");
  });

  it("exposes the civil date so generateSlots reads the intended Y/M/D", () => {
    const range = resolveDayRange("2026-09-13", "America/Argentina/Buenos_Aires");

    expect(range?.date.getFullYear()).toBe(2026);
    expect(range?.date.getMonth()).toBe(8); // 0-indexed: septiembre
    expect(range?.date.getDate()).toBe(13);
  });

  it("spans 24h on a day without DST transition", () => {
    const range = resolveDayRange("2026-09-13", "America/Argentina/Buenos_Aires");

    expect(spanHours(range!.startIso, range!.endIso)).toBe(24);
  });

  // Chile cambia la hora a las 24:00: el día de spring-forward la medianoche
  // NO existe y el día civil dura 23h. Construir el fin con addDays sobre un
  // inicio ya normalizado a las 01:00 daba 24h y se comía la primera hora del
  // día siguiente.
  it("spans 23h when the timezone's DST jump lands on midnight (Chile)", () => {
    const range = resolveDayRange("2026-09-06", "America/Santiago");

    expect(range?.startIso).toBe("2026-09-06T04:00:00.000Z");
    expect(range?.endIso).toBe("2026-09-07T03:00:00.000Z");
    expect(spanHours(range!.startIso, range!.endIso)).toBe(23);
  });

  it("spans 23h on a spring-forward day whose midnight exists (US)", () => {
    const range = resolveDayRange("2026-03-08", "America/New_York");

    expect(spanHours(range!.startIso, range!.endIso)).toBe(23);
  });

  it("spans 25h on a fall-back day", () => {
    const range = resolveDayRange("2026-11-01", "America/New_York");

    expect(spanHours(range!.startIso, range!.endIso)).toBe(25);
  });

  it("rolls over into the next month", () => {
    const range = resolveDayRange("2026-08-31", "America/Santiago");

    expect(range?.endIso).toBe("2026-09-01T04:00:00.000Z");
  });

  it("rolls over into the next year", () => {
    const range = resolveDayRange("2026-12-31", "America/Santiago");

    expect(range?.endIso).toBe("2027-01-01T03:00:00.000Z");
  });

  it.each(["", "2026-9-6", "not-a-date", "2026-09", "2026-09-06T10:00"])(
    "returns null for the malformed input %o",
    (input) => {
      expect(resolveDayRange(input, "America/Santiago")).toBeNull();
    },
  );

  it.each(["2026-13-01", "2026-02-30", "2026-00-10"])(
    "returns null for the non-existent civil date %s",
    (input) => {
      expect(resolveDayRange(input, "America/Santiago")).toBeNull();
    },
  );
});

describe("resolveMonthRange", () => {
  it("returns the civil month boundaries as UTC ISO instants", () => {
    const range = resolveMonthRange("2026-09", "America/Argentina/Buenos_Aires");

    expect(range).not.toBeNull();
    expect(range?.startIso).toBe("2026-09-01T03:00:00.000Z");
    expect(range?.endIso).toBe("2026-10-01T03:00:00.000Z");
  });

  it("spans 720h on a 30-day month without DST transition", () => {
    const range = resolveMonthRange("2026-09", "America/Argentina/Buenos_Aires");

    expect(spanHours(range!.startIso, range!.endIso)).toBe(720);
  });

  // Mismo peligro que en resolveDayRange, un nivel más arriba: el fin se
  // construye como el mes civil SIGUIENTE, no con addMonths sobre el inicio.
  // En Chile el salto de DST cae sobre la medianoche del 6 de septiembre, así
  // que el inicio de mes queda normalizado y arrastrarlo daría 720h para un mes
  // que dura 719, comiéndose la primera hora de octubre.
  it("spans 719h when the month contains a midnight DST jump (Chile)", () => {
    const range = resolveMonthRange("2026-09", "America/Santiago");

    expect(range?.startIso).toBe("2026-09-01T04:00:00.000Z");
    expect(range?.endIso).toBe("2026-10-01T03:00:00.000Z");
    expect(spanHours(range!.startIso, range!.endIso)).toBe(719);
  });

  it("spans 743h on a spring-forward month (US)", () => {
    const range = resolveMonthRange("2026-03", "America/New_York");

    expect(spanHours(range!.startIso, range!.endIso)).toBe(743);
  });

  it("spans 721h on a fall-back month (US)", () => {
    const range = resolveMonthRange("2026-11", "America/New_York");

    expect(spanHours(range!.startIso, range!.endIso)).toBe(721);
  });

  it("rolls over into the next year", () => {
    const range = resolveMonthRange("2026-12", "America/Argentina/Buenos_Aires");

    expect(range?.startIso).toBe("2026-12-01T03:00:00.000Z");
    expect(range?.endIso).toBe("2027-01-01T03:00:00.000Z");
  });

  it.each(["", "2026-9", "2026", "not-a-month", "2026-09-01", "2026-09T10:00"])(
    "returns null for the malformed input %o",
    (input) => {
      expect(resolveMonthRange(input, "America/Santiago")).toBeNull();
    },
  );

  it.each(["2026-13", "2026-00"])(
    "returns null for the non-existent civil month %s",
    (input) => {
      expect(resolveMonthRange(input, "America/Santiago")).toBeNull();
    },
  );
});
