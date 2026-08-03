import { describe, expect, it } from "vitest";

import { describeBookingStatus } from "./booking-status";
import type { BookingStatus } from "./types";

describe("describeBookingStatus", () => {
  it("maps each known status to its label and badge tone", () => {
    expect(describeBookingStatus("pending")).toEqual({
      label: "Pendiente",
      tone: "gold",
    });
    expect(describeBookingStatus("confirmed")).toEqual({
      label: "Confirmado",
      tone: "success",
    });
    expect(describeBookingStatus("cancelled")).toEqual({
      label: "Cancelado",
      tone: "danger",
    });
    expect(describeBookingStatus("completed")).toEqual({
      label: "Completado",
      tone: "info",
    });
    expect(describeBookingStatus("no_show")).toEqual({
      label: "No asistió",
      tone: "muted",
    });
  });

  it("falls back to a neutral badge for an unexpected status from the DB", () => {
    expect(describeBookingStatus("rescheduled" as BookingStatus)).toEqual({
      label: "rescheduled",
      tone: "muted",
    });
  });
});
