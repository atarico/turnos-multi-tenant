import { describe, expect, it } from "vitest";

import { generateSlots, type SlotGenerationInput } from "./slots";
import type { BookingLoad, WeeklyAvailability } from "./types";

/**
 * Behavior-first tests for the booking slot engine. They assert the SAME
 * contract the DB enforces in `create_booking()` (migration 20260605120003):
 * availability-window boundaries, capacity/group-session counting, the
 * `p_starts_at <= now()` past-time cutoff, and weekday via extract(dow).
 *
 * `now` is always injected so the suite is deterministic regardless of the
 * machine clock or timezone.
 */

const SERVICE_ID = "svc-1";

/** Buenos Aires observes no DST — a stable UTC-3 offset for the plain cases. */
const BA_TZ = "America/Argentina/Buenos_Aires";

/** 2024-06-10 is a Monday (getDay === 1). */
const MONDAY = new Date(2024, 5, 10);
/** 2024-06-11 is a Tuesday (getDay === 2). */
const TUESDAY = new Date(2024, 5, 11);

/** Far enough in the past that nothing is filtered as "already passed". */
const LONG_AGO = new Date("2024-01-01T00:00:00.000Z");

function baseInput(over: Partial<SlotGenerationInput> = {}): SlotGenerationInput {
  return {
    date: MONDAY,
    timezone: BA_TZ,
    serviceId: SERVICE_ID,
    durationMin: 60,
    capacity: 1,
    windows: [],
    load: [],
    now: LONG_AGO,
    ...over,
  };
}

function window(
  weekday: number,
  startTime: string,
  endTime: string,
): WeeklyAvailability {
  return { weekday, startTime, endTime };
}

function booking(startsAt: string, endsAt: string, serviceId = SERVICE_ID): BookingLoad {
  return { serviceId, startsAt, endsAt };
}

describe("generateSlots — availability window boundaries", () => {
  it("emits back-to-back slots and excludes the one that would end after the window", () => {
    const slots = generateSlots(
      baseInput({ windows: [window(1, "09:00", "12:00")] }),
    );

    // 09:00 + 60 = 10:00, 10:00 + 60 = 11:00, 11:00 + 60 = 12:00 (== end, kept).
    // 12:00 + 60 = 13:00 (> end) → excluded. Exact boundary asserted.
    expect(slots.map((s) => s.label)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("keeps the slot whose end lands exactly on the window end", () => {
    const slots = generateSlots(
      baseInput({ windows: [window(1, "09:00", "10:00")] }),
    );
    expect(slots.map((s) => s.label)).toEqual(["09:00"]);
  });
});

describe("generateSlots — capacity (mirrors create_booking counting)", () => {
  it("marks a 1-on-1 slot as full when it already has a booking", () => {
    // BA is UTC-3, so 09:00 local === 12:00Z.
    const slots = generateSlots(
      baseInput({
        capacity: 1,
        windows: [window(1, "09:00", "11:00")],
        load: [booking("2024-06-10T12:00:00.000Z", "2024-06-10T13:00:00.000Z")],
      }),
    );

    const nine = slots.find((s) => s.label === "09:00")!;
    const ten = slots.find((s) => s.label === "10:00")!;
    expect(nine.available).toBe(false);
    expect(nine.remaining).toBe(0);
    expect(ten.available).toBe(true);
    expect(ten.remaining).toBe(1);
  });

  it("counts remaining seats for a group service and only disables when full", () => {
    const twoTaken = generateSlots(
      baseInput({
        capacity: 3,
        windows: [window(1, "09:00", "10:00")],
        load: [
          booking("2024-06-10T12:00:00.000Z", "2024-06-10T13:00:00.000Z"),
          booking("2024-06-10T12:00:00.000Z", "2024-06-10T13:00:00.000Z"),
        ],
      }),
    );
    const partial = twoTaken.find((s) => s.label === "09:00")!;
    expect(partial.remaining).toBe(1); // capacity 3 − 2 taken
    expect(partial.available).toBe(true);

    const threeTaken = generateSlots(
      baseInput({
        capacity: 3,
        windows: [window(1, "09:00", "10:00")],
        load: [
          booking("2024-06-10T12:00:00.000Z", "2024-06-10T13:00:00.000Z"),
          booking("2024-06-10T12:00:00.000Z", "2024-06-10T13:00:00.000Z"),
          booking("2024-06-10T12:00:00.000Z", "2024-06-10T13:00:00.000Z"),
        ],
      }),
    );
    const full = threeTaken.find((s) => s.label === "09:00")!;
    expect(full.remaining).toBe(0);
    expect(full.available).toBe(false);
  });

  it("treats a different overlapping session as the professional being busy (remaining 0)", () => {
    // Matches v_others > 0 in the RPC: another service overlapping → busy.
    const slots = generateSlots(
      baseInput({
        capacity: 5,
        windows: [window(1, "09:00", "10:00")],
        load: [
          booking(
            "2024-06-10T12:00:00.000Z",
            "2024-06-10T13:00:00.000Z",
            "other-service",
          ),
        ],
      }),
    );
    const nine = slots.find((s) => s.label === "09:00")!;
    expect(nine.remaining).toBe(0);
    expect(nine.available).toBe(false);
  });
});

describe("generateSlots — past-time filtering (p_starts_at <= now())", () => {
  it("excludes a slot whose start is exactly `now` (boundary), keeps later ones", () => {
    const slots = generateSlots(
      baseInput({
        windows: [window(1, "09:00", "11:00")],
        // 09:00 BA === 12:00Z: inject now at exactly that instant.
        now: new Date("2024-06-10T12:00:00.000Z"),
      }),
    );
    expect(slots.map((s) => s.label)).toEqual(["10:00"]);
  });

  it("keeps a slot whose start is one second after `now`", () => {
    const slots = generateSlots(
      baseInput({
        windows: [window(1, "09:00", "11:00")],
        now: new Date("2024-06-10T11:59:59.000Z"),
      }),
    );
    expect(slots.map((s) => s.label)).toEqual(["09:00", "10:00"]);
  });
});

describe("generateSlots — weekday mapping (JS getDay === extract(dow))", () => {
  it("produces slots when the date's weekday matches the window weekday", () => {
    const slots = generateSlots(
      baseInput({ date: MONDAY, windows: [window(1, "09:00", "10:00")] }),
    );
    expect(slots).toHaveLength(1);
  });

  it("produces no slots when the date's weekday differs from the window", () => {
    const slots = generateSlots(
      baseInput({ date: TUESDAY, windows: [window(1, "09:00", "10:00")] }),
    );
    expect(slots).toHaveLength(0);
  });
});

describe("generateSlots — DST spring-forward gap (America/New_York, 2024-03-10)", () => {
  const NY_TZ = "America/New_York";
  // 2024-03-10 is a Sunday (getDay === 0); clocks jump 02:00 → 03:00 EDT.
  const SPRING_FORWARD = new Date(2024, 2, 10);

  it("never offers the nonexistent 02:00 local hour and keeps the real 03:00 slot", () => {
    const slots = generateSlots(
      baseInput({
        timezone: NY_TZ,
        date: SPRING_FORWARD,
        windows: [window(0, "01:00", "04:00")],
        now: new Date("2024-03-01T00:00:00.000Z"),
      }),
    );

    // The nonexistent 02:00–02:59 wall-clock must NOT be offered.
    expect(slots.some((s) => s.label === "02:00")).toBe(false);

    // The real 01:00 (EST, UTC-5) and 03:00 (EDT, UTC-4) must survive.
    const one = slots.find((s) => s.label === "01:00");
    const three = slots.find((s) => s.label === "03:00");

    expect(one).toBeDefined();
    expect(one!.startsAt).toBe("2024-03-10T06:00:00.000Z");

    expect(three).toBeDefined();
    expect(three!.startsAt).toBe("2024-03-10T07:00:00.000Z");

    // No two returned slots may share the same absolute instant.
    const instants = slots.map((s) => s.startsAt);
    expect(new Set(instants).size).toBe(instants.length);
  });
});
