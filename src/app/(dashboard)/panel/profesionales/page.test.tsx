import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StaffMember } from "@/modules/staff/domain/types";
import type { Tenant } from "@/modules/tenants/domain/types";

vi.mock("@/modules/tenants/application/queries", () => ({
  getCurrentTenant: vi.fn(),
}));
vi.mock("@/modules/catalog/application/queries", () => ({
  listCatalogServices: vi.fn(async () => ({ ok: true, value: [] })),
}));
vi.mock("@/modules/staff/application/queries", () => ({
  listStaffMembers: vi.fn(async () => ({ ok: true, value: [] })),
}));
// Las actions arrastrarían el cliente de Supabase al importarse: acá sólo
// importa lo que la pantalla pinta.
vi.mock("@/modules/staff/application/actions", () => ({
  deleteStaffAction: vi.fn(),
  saveStaffAction: vi.fn(),
  toggleStaffActiveAction: vi.fn(),
}));

const tenant: Tenant = {
  id: "t1",
  slug: "acme",
  name: "Acme",
  country: "AR",
  timezone: "America/Argentina/Buenos_Aires",
  plan: "basico",
  paid_plan: "basico",
  plan_courtesy: null,
  plan_courtesy_until: null,
  plan_courtesy_reason: null,
  logo_url: null,
  brand_color: "#e3b23c",
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

describe("StaffPage", () => {
  it(
    "cruza al catálogo sin pasar por el panel",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      expect(screen.getByRole("link", { name: "Servicios" })).toHaveAttribute(
        "href",
        "/panel/servicios",
      );
    },
  );

  it(
    "vuelve al panel general con un único control, ya no con la flecha suelta",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      expect(
        screen.getByRole("link", { name: "Volver al panel general" }),
      ).toHaveAttribute("href", "/panel");
      expect(screen.queryByRole("link", { name: "Panel" })).toBeNull();
    },
  );
});

/**
 * Un profesional del negocio. Sólo interesa `active`, que es lo que gasta cupo.
 */
const member = (id: string, active: boolean): StaffMember => ({
  id,
  name: `Profesional ${id}`,
  role: null,
  active,
  serviceIds: [],
});

/**
 * El renglón del cupo.
 *
 * Se busca por `[data-staff-quota]` y no por texto porque el número va en un
 * `<b>`: un matcher de texto encontraría el nodo del número suelto y nunca la
 * frase entera. Tampoco por clase — las utilidades de Tailwind están para el
 * aspecto, y cambiar el color rompería un test que es sobre lo que se DICE.
 */
const quotaNotice = (): HTMLElement | null =>
  document.querySelector("[data-staff-quota]");

/**
 * El cupo de profesionales, visto desde la pantalla donde se administra.
 *
 * El caso que importa no es el que está lleno: es el que BAJÓ de plan y quedó
 * por encima del tope. Ese no rompió ninguna regla y no se le borra a nadie,
 * pero su próxima alta se va a trabar. Enterarse recién ahí es la falla que
 * esta pantalla tiene que evitar.
 */
describe("StaffPage · cupo del plan", () => {
  it(
    "al que quedó por encima del cupo le avisa que no perdió a nadie y que la próxima alta se traba",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listStaffMembers } = await import(
        "@/modules/staff/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      // Básico permite 2. Tres activos es el negocio que degradó.
      vi.mocked(listStaffMembers).mockResolvedValue({
        ok: true,
        value: [member("a", true), member("b", true), member("c", true)],
      });
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      const notice = quotaNotice();
      expect(notice).toHaveTextContent("3");
      expect(notice).toHaveTextContent("2");
      // Las dos cosas que tiene que contestar: qué NO pasa y qué sí.
      expect(notice).toHaveTextContent(/no sacamos a nadie/i);
      expect(notice).toHaveTextContent(/pausar/i);
    },
  );

  it(
    "al que está justo en el tope le ofrece la salida en vez de retarlo",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listStaffMembers } = await import(
        "@/modules/staff/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(listStaffMembers).mockResolvedValue({
        ok: true,
        value: [member("a", true), member("b", true)],
      });
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      const notice = quotaNotice();
      expect(notice).toHaveTextContent(/tope/i);
      // Estar lleno NO es haberse pasado: acá no corresponde el aviso del que
      // degradó, que habla de gente que ya no entra.
      expect(notice).not.toHaveTextContent(/no sacamos a nadie/i);
      expect(
        screen.getByRole("link", { name: "Cambiar de plan" }),
      ).toHaveAttribute("href", "/panel/suscripcion");
    },
  );

  it(
    "debajo del cupo muestra el conteo y nada más",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listStaffMembers } = await import(
        "@/modules/staff/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      // Un pausado no gasta cupo: son dos filas y un solo activo.
      vi.mocked(listStaffMembers).mockResolvedValue({
        ok: true,
        value: [member("a", true), member("b", false)],
      });
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      const notice = quotaNotice();
      expect(notice).toHaveTextContent("1");
      expect(notice).toHaveTextContent("2");
      // Sin margen consumido no hay nada que ofrecer: un link a cambiar de
      // plan acá es venderle algo al que no lo necesita.
      expect(screen.queryByRole("link", { name: "Cambiar de plan" })).toBeNull();
    },
  );

  it(
    "si no pudo leer los profesionales no inventa un conteo",
    { timeout: 15000 },
    async () => {
      const { getCurrentTenant } = await import(
        "@/modules/tenants/application/queries"
      );
      const { listStaffMembers } = await import(
        "@/modules/staff/application/queries"
      );
      vi.mocked(getCurrentTenant).mockResolvedValue(tenant);
      vi.mocked(listStaffMembers).mockResolvedValue({
        ok: false,
        error: {
          code: "staff_query_failed",
          message: "No pudimos cargar tus profesionales.",
        },
      });
      const { default: StaffPage } = await import("./page");

      render(await StaffPage());

      // La lista vacía de un fallo se leería como "no tenés a nadie activo",
      // que es una respuesta — y acá no la tenemos. Sin dato, sin renglón.
      expect(quotaNotice()).toBeNull();
    },
  );
});
