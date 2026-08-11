import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPublicBookingAction } from "./public-actions";

/**
 * Tests de `createPublicBookingAction`, la única puerta pública de reserva.
 *
 * Lo que se fija acá es el CONTRATO del freno anti-spam: la action tiene que
 * llamar a `create_public_booking` (cliente service_role) con el origen ya
 * hasheado —nunca la IP cruda— y traducir los errores de la RPC (incluido el
 * freno) a mensajes accionables. La cuota en sí vive en la base y no se
 * testea acá.
 */

const SALT = "unit-test-salt-0123456789";

/** Réplica del fingerprint esperado: sha256 hex de `${salt}:${ip}`. */
function fingerprint(ip: string): string {
  return createHash("sha256").update(`${SALT}:${ip}`).digest("hex");
}

const headerGet = vi.fn<(name: string) => string | null>(() => null);
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => headerGet(name) }),
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ BOOKING_IP_SALT: SALT }),
}));

const rpc = vi.fn<(...args: unknown[]) => Promise<{ error: { message: string } | null }>>(
  async () => ({ error: null }),
);
const createAdminClient = vi.fn(() => ({ rpc }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClient(),
}));

const getTenantBySlug = vi.fn(async (): Promise<unknown> => ({
  id: "tenant-1",
  slug: "negocio",
  timezone: "America/Argentina/Buenos_Aires",
}));
vi.mock("@/modules/tenants/application/queries", () => ({
  getTenantBySlug: () => getTenantBySlug(),
}));

// Las otras actions del archivo importan las queries públicas; se mockean para
// que el import del módulo no arrastre al cliente Supabase real.
vi.mock("./public-queries", () => ({
  getPublicBookingLoad: vi.fn(),
  getPublicService: vi.fn(),
  getPublicStaffAvailability: vi.fn(),
  listPublicStaffForService: vi.fn(),
  staffBelongsToTenant: vi.fn(),
}));

const SERVICE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const STAFF_ID = "8b7d3a10-2c4e-4f5a-9b6c-1d2e3f4a5b6c";
const STARTS_AT = "2026-09-01T13:00:00.000Z";

/** Payload mínimo válido según `bookingSchema`, tal como lo manda el flow. */
function validInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    service_id: SERVICE_ID,
    staff_id: STAFF_ID,
    starts_at: STARTS_AT,
    customer_name: "Ana",
    customer_email: "",
    ...overrides,
  };
}

/** Último `p_ip_hash` que recibió la RPC. */
function sentIpHash(): string {
  const args = rpc.mock.calls.at(-1);
  return (args?.[1] as { p_ip_hash: string }).p_ip_hash;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ error: null });
  headerGet.mockReturnValue(null);
  getTenantBySlug.mockResolvedValue({
    id: "tenant-1",
    slug: "negocio",
    timezone: "America/Argentina/Buenos_Aires",
  });
});

describe("createPublicBookingAction", () => {
  it("books via create_public_booking with the resolved slug and hashed origin", async () => {
    headerGet.mockImplementation((name) =>
      name === "x-forwarded-for" ? "203.0.113.9" : null,
    );

    const result = await createPublicBookingAction("negocio", validInput());

    expect(result).toEqual({ status: "success", message: "Reserva confirmada." });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_public_booking", {
      // El slug que viaja a la RPC es el del tenant RESUELTO, no el input crudo.
      p_tenant_slug: "negocio",
      p_staff_id: STAFF_ID,
      p_service_id: SERVICE_ID,
      p_starts_at: STARTS_AT,
      p_customer_name: "Ana",
      p_ip_hash: fingerprint("203.0.113.9"),
      p_customer_email: null,
      p_customer_phone: null,
    });
  });

  it("passes email and phone through when the visitor filled them", async () => {
    await createPublicBookingAction(
      "negocio",
      validInput({ customer_email: "ana@mail.com", customer_phone: "11-5555" }),
    );

    expect(rpc).toHaveBeenCalledWith(
      "create_public_booking",
      expect.objectContaining({
        p_customer_email: "ana@mail.com",
        p_customer_phone: "11-5555",
      }),
    );
  });

  // `x-forwarded-for` puede traer la cadena de proxies: el cliente real es el
  // PRIMERO. Tomar otro dejaría contar por proxy y no por visitante.
  it("fingerprints the FIRST entry of x-forwarded-for, trimmed", async () => {
    headerGet.mockImplementation((name) =>
      name === "x-forwarded-for" ? " 203.0.113.9 , 10.0.0.1, 172.16.0.1" : null,
    );

    await createPublicBookingAction("negocio", validInput());

    expect(sentIpHash()).toBe(fingerprint("203.0.113.9"));
  });

  it("falls back to x-real-ip when x-forwarded-for is missing", async () => {
    headerGet.mockImplementation((name) =>
      name === "x-real-ip" ? "198.51.100.7" : null,
    );

    await createPublicBookingAction("negocio", validInput());

    expect(sentIpHash()).toBe(fingerprint("198.51.100.7"));
  });

  it("falls back to x-real-ip when x-forwarded-for is blank", async () => {
    headerGet.mockImplementation((name) => {
      if (name === "x-forwarded-for") return "   ";
      if (name === "x-real-ip") return "198.51.100.7";
      return null;
    });

    await createPublicBookingAction("negocio", validInput());

    expect(sentIpHash()).toBe(fingerprint("198.51.100.7"));
  });

  // Sin cabecera de origen NO se abre un carril sin freno: todas esas requests
  // comparten un único bucket, o sea un mismo hash.
  it("shares one unknown-origin bucket when no origin header arrives", async () => {
    await createPublicBookingAction("negocio", validInput());
    await createPublicBookingAction("negocio", validInput());

    const [first, second] = rpc.mock.calls.map(
      (args) => (args[1] as { p_ip_hash: string }).p_ip_hash,
    );
    expect(first).toBe(fingerprint("unknown-origin"));
    expect(second).toBe(first);
  });

  // El hash existe para NO persistir la IP: si el valor enviado contuviera la
  // IP cruda, terminaría en backups y dumps de la base.
  it("never sends the raw IP, only a salted sha256 hex digest", async () => {
    headerGet.mockImplementation((name) =>
      name === "x-forwarded-for" ? "203.0.113.9" : null,
    );

    await createPublicBookingAction("negocio", validInput());

    const hash = sentIpHash();
    expect(hash).not.toContain("203.0.113.9");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      "demasiadas reservas desde este origen",
      "Hiciste varias reservas seguidas. Esperá un rato y volvé a intentar.",
    ],
    [
      "origen no identificado",
      "No pudimos procesar la reserva desde este origen. Probá de nuevo.",
    ],
  ])("translates the RPC throttle error %o into a friendly message", async (raw, friendly) => {
    rpc.mockResolvedValue({ error: { message: raw } });

    const result = await createPublicBookingAction("negocio", validInput());

    expect(result).toEqual({ status: "error", message: friendly });
  });

  it("falls back to the generic booking message for an unknown RPC error", async () => {
    rpc.mockResolvedValue({ error: { message: "connection reset by peer" } });

    const result = await createPublicBookingAction("negocio", validInput());

    expect(result).toEqual({
      status: "error",
      message: "No pudimos crear la reserva. Revisá los datos e intentá de nuevo.",
    });
  });

  it("rejects invalid input with field errors, without touching the database", async () => {
    const result = await createPublicBookingAction(
      "negocio",
      validInput({ staff_id: "not-a-uuid" }),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.fieldErrors).toHaveProperty("staff_id");
    }
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stops when the slug resolves to no tenant, without touching the database", async () => {
    getTenantBySlug.mockResolvedValue(null);

    const result = await createPublicBookingAction("no-existe", validInput());

    expect(result).toEqual({
      status: "error",
      message: "No encontramos ese negocio.",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
