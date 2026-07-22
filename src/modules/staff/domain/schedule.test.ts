import { describe, expect, it } from "vitest";

import { buildWeeklySchedule, normalizeTime, WEEKDAYS } from "./schedule";

describe("WEEKDAYS", () => {
  it("lists the week starting on Monday but keeps the postgres dow values", () => {
    expect(WEEKDAYS.map((d) => d.value)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(WEEKDAYS[0].label).toBe("Lunes");
    // 0 = domingo, igual que extract(dow) y que staff_availability.weekday.
    expect(WEEKDAYS[6]).toEqual({ value: 0, label: "Domingo" });
  });
});

describe("normalizeTime", () => {
  it("drops the seconds postgres returns for a time column", () => {
    expect(normalizeTime("09:00:00")).toBe("09:00");
  });

  it("keeps an already normalized value", () => {
    expect(normalizeTime("18:30")).toBe("18:30");
  });

  it("rejects anything that is not a real time of day", () => {
    expect(normalizeTime("")).toBeNull();
    expect(normalizeTime("9:00")).toBeNull();
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("09:60")).toBeNull();
    expect(normalizeTime("mañana")).toBeNull();
  });
});

describe("buildWeeklySchedule", () => {
  it("accepts an empty week: a professional may simply not work yet", () => {
    const result = buildWeeklySchedule([]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual([]);
  });

  it("normalizes and sorts by weekday and start time", () => {
    const result = buildWeeklySchedule([
      { weekday: "3", startTime: "14:00:00", endTime: "18:00" },
      { weekday: "1", startTime: "09:00", endTime: "13:00" },
      { weekday: "3", startTime: "09:00", endTime: "13:00" },
    ]);

    expect(result.ok && result.value).toEqual([
      { weekday: 1, startTime: "09:00", endTime: "13:00" },
      { weekday: 3, startTime: "09:00", endTime: "13:00" },
      { weekday: 3, startTime: "14:00", endTime: "18:00" },
    ]);
  });

  it("allows back-to-back windows: they touch, they do not overlap", () => {
    const result = buildWeeklySchedule([
      { weekday: "1", startTime: "09:00", endTime: "13:00" },
      { weekday: "1", startTime: "13:00", endTime: "18:00" },
    ]);

    expect(result.ok).toBe(true);
  });

  it("allows the same hours on different weekdays", () => {
    const result = buildWeeklySchedule([
      { weekday: "1", startTime: "09:00", endTime: "13:00" },
      { weekday: "2", startTime: "09:00", endTime: "13:00" },
    ]);

    expect(result.ok).toBe(true);
  });

  it("rejects overlapping windows on the same weekday", () => {
    const result = buildWeeklySchedule([
      { weekday: "1", startTime: "09:00", endTime: "14:00" },
      { weekday: "1", startTime: "13:00", endTime: "18:00" },
    ]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("overlapping_windows");
  });

  it("rejects a window that ends before it starts", () => {
    const result = buildWeeklySchedule([
      { weekday: "1", startTime: "18:00", endTime: "09:00" },
    ]);

    expect(!result.ok && result.error.code).toBe("invalid_range");
  });

  it("rejects a window with no duration", () => {
    const result = buildWeeklySchedule([
      { weekday: "1", startTime: "09:00", endTime: "09:00" },
    ]);

    expect(!result.ok && result.error.code).toBe("invalid_range");
  });

  it("rejects a weekday outside 0..6", () => {
    const result = buildWeeklySchedule([
      { weekday: "7", startTime: "09:00", endTime: "13:00" },
    ]);

    expect(!result.ok && result.error.code).toBe("invalid_weekday");
  });

  it("rejects an unparseable time", () => {
    const result = buildWeeklySchedule([
      { weekday: "1", startTime: "mañana", endTime: "13:00" },
    ]);

    expect(!result.ok && result.error.code).toBe("invalid_time");
  });
});
