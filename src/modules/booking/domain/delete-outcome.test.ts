import { describe, expect, it } from "vitest";

import { deleteBlockMessage } from "./delete-outcome";

describe("deleteBlockMessage", () => {
  it.each([
    [
      "blocked_upcoming" as const,
      "servicio" as const,
      "Este servicio tiene turnos agendados. Cancelalos o esperá a que pasen para poder eliminarlo.",
    ],
    [
      "blocked_upcoming" as const,
      "profesional" as const,
      "Este profesional tiene turnos agendados. Cancelalos o esperá a que pasen para poder eliminarlo.",
    ],
    [
      "blocked_history" as const,
      "servicio" as const,
      "Este servicio tiene turnos completados en tu historial, así que no se puede eliminar. Pausalo para dejar de ofrecerlo.",
    ],
    [
      "blocked_history" as const,
      "profesional" as const,
      "Este profesional tiene turnos completados en tu historial, así que no se puede eliminar. Pausalo para dejar de ofrecerlo.",
    ],
  ])("maps %s for %s to the exact Spanish copy", (outcome, subject, expected) => {
    expect(deleteBlockMessage(outcome, subject)).toBe(expected);
  });
});
