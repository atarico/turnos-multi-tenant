import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ok } from "@/core/result";

import { listPublicStaffAction } from "../application/public-actions";
import type { BookableService } from "../domain/types";
import { PublicBookingFlow } from "./public-booking-flow";

/**
 * The public route reuses `BookingFlow` but must reach the anonymous Server
 * Actions, which take the tenant `slug` as their first argument. This test pins
 * the one piece of logic `PublicBookingFlow` owns: currying the slug into every
 * forwarded action. It drives a real click and asserts the slug arrives.
 */
vi.mock("../application/public-actions", () => ({
  listPublicStaffAction: vi.fn(),
  getPublicAvailabilityAction: vi.fn(),
  getPublicSlotsAction: vi.fn(),
  createPublicBookingAction: vi.fn(),
}));

const service: BookableService = {
  id: "s1",
  name: "Corte",
  description: null,
  durationMin: 30,
  priceCents: 500000,
  currency: "ARS",
  capacity: 1,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("PublicBookingFlow", () => {
  it("injects the tenant slug into the public actions forwarded to BookingFlow", async () => {
    vi.mocked(listPublicStaffAction).mockResolvedValue(ok([]));
    const user = userEvent.setup({ delay: null });

    render(
      <PublicBookingFlow
        slug="barberia-acme"
        services={[service]}
        timezone="America/Argentina/Buenos_Aires"
      />,
    );

    await user.click(screen.getByText("Corte"));

    expect(listPublicStaffAction).toHaveBeenCalledWith("barberia-acme", "s1");
  });
});
