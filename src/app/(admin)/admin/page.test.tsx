import { render, screen, within } from "@testing-library/react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AdminTenant } from "@/modules/admin/domain/types";

vi.mock("@/modules/admin/application/queries", () => ({
  listAllTenants: vi.fn(async () => ({ ok: true, value: [] })),
}));
// La server action arrastraría el cliente de Supabase al importarse; acá sólo
// importa que el formulario exista y apunte a ella.
vi.mock("@/modules/auth/application/actions", () => ({
  signOutAction: vi.fn(),
}));

const tenants: AdminTenant[] = [
  {
    id: "t2",
    slug: "nuevo",
    name: "Peluquería Nueva",
    country: "MX",
    plan: "pro",
    created_at: "2026-08-02T00:00:00Z",
  },
  {
    id: "t1",
    slug: "viejo",
    name: "Barbería Vieja",
    country: "AR",
    plan: "basico",
    created_at: "2026-08-01T00:00:00Z",
  },
];

/**
 * Fixture a propósito DESORDENADO —ni por alta ni alfabético— y con nombres que
 * no se parecen entre sí.
 *
 * La página no ordena nada: pinta `result.value` en el orden en que le llegó, y
 * el "del más nuevo al más viejo" que promete el copy lo garantiza el
 * `.order("created_at", { ascending: false })` de `listAllTenants` (probado en
 * `queries.test.ts`). Justamente por eso lo que hay que fijar acá es que la
 * página PRESERVE el orden que recibe: si algún día alguien le mete un `sort`
 * o un `reverse` "para asegurarse", la lista pasaría a contradecir a la
 * consulta y con un fixture ya ordenado el test no se enteraría.
 */
const desordenados: AdminTenant[] = [
  {
    id: "t3",
    slug: "zeta",
    name: "Zeta Studio",
    country: "CL",
    plan: "premium",
    created_at: "2026-08-03T00:00:00Z",
  },
  {
    id: "t1",
    slug: "alfa",
    name: "Alfa Barbería",
    country: "AR",
    plan: "basico",
    created_at: "2026-08-01T00:00:00Z",
  },
  {
    id: "t2",
    slug: "medio",
    name: "Medio Salón",
    country: "UY",
    plan: "pro",
    created_at: "2026-08-02T00:00:00Z",
  },
];

/**
 * Timeout subido igual que en las páginas hermanas del panel: misma forma y el
 * mismo riesgo de pasarse de los 5000ms por defecto con la suite entera
 * corriendo, sin que la página tenga nada más lento adentro.
 */
describe("AdminPage", () => {
  /**
   * Sin esto, un caso que se olvide de setear el mock hereda en silencio el
   * valor del anterior y pasa probando la lista del test de al lado.
   *
   * `clearAllMocks` solo por sí solo NO alcanza: borra las llamadas
   * registradas, no la implementación, así que el `mockResolvedValue` del test
   * anterior seguiría vivo. Por eso además se vuelve a plantar el default de la
   * fábrica del mock, que es el estado en el que un olvido se nota (la pantalla
   * de plataforma vacía) en vez de pasar de largo.
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    const { listAllTenants } = await import(
      "@/modules/admin/application/queries"
    );
    vi.mocked(listAllTenants).mockResolvedValue({ ok: true, value: [] });
  });

  it("lista un negocio por cada fila", { timeout: 15000 }, async () => {
    const { listAllTenants } = await import(
      "@/modules/admin/application/queries"
    );
    vi.mocked(listAllTenants).mockResolvedValue({ ok: true, value: tenants });
    const { default: AdminPage } = await import("./page");

    render(await AdminPage());

    expect(screen.getByText("Peluquería Nueva")).toBeInTheDocument();
    expect(screen.getByText("Barbería Vieja")).toBeInTheDocument();
    // El slug es lo único que identifica al negocio de forma única para quien
    // administra: dos negocios pueden llamarse igual, la URL no.
    expect(screen.getByText("/nuevo")).toBeInTheDocument();
    expect(screen.getByText("/viejo")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("México")).toBeInTheDocument();
  });

  /**
   * Cuántas filas y en qué orden, leído del DOM.
   *
   * Buscar seis strings sueltos no prueba ninguna de las dos cosas: pasa igual
   * si la página pinta una fila de más, si se come una, o si invierte la lista
   * —que es el bug que contradiría el "del más nuevo al más viejo" del copy—.
   * El nombre se saca de cada `li` en orden de documento justamente para que la
   * afirmación sea sobre la secuencia y no sobre la presencia.
   */
  it(
    "pinta una fila por negocio y respeta el orden que le llegó",
    { timeout: 15000 },
    async () => {
      const { listAllTenants } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(listAllTenants).mockResolvedValue({
        ok: true,
        value: desordenados,
      });
      const { default: AdminPage } = await import("./page");

      render(await AdminPage());

      const filas = screen.getAllByRole("listitem");
      expect(filas).toHaveLength(desordenados.length);
      expect(
        filas.map(
          (fila) => within(fila).getByRole("heading", { level: 2 }).textContent,
        ),
      ).toEqual(["Zeta Studio", "Alfa Barbería", "Medio Salón"]);
    },
  );

  /**
   * La fecha de alta se pinta en UTC, y esto es lo que lo prueba.
   *
   * Las otras fixtures usan medianoche UTC, que en muchas zonas horarias cae el
   * mismo día calendario que en local: con ellas se puede sacar el `TZDate` y
   * no se entera nadie. Esta hora está elegida para que las dos lecturas NO
   * coincidan — 02:30 UTC del 10 de marzo son las 23:30 del 9 en Buenos
   * Aires—, y la tz del proceso se fija a mano para que el test dé lo mismo en
   * la máquina de cualquiera y en CI, que es exactamente la propiedad que el
   * `TZDate` le da a la pantalla.
   */
  describe("con el proceso en horario argentino", () => {
    const tzOriginal = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "America/Argentina/Buenos_Aires";
    });
    afterAll(() => {
      process.env.TZ = tzOriginal;
    });

    it(
      "muestra el día calendario UTC del alta, no el local",
      { timeout: 15000 },
      async () => {
        const { listAllTenants } = await import(
          "@/modules/admin/application/queries"
        );
        vi.mocked(listAllTenants).mockResolvedValue({
          ok: true,
          value: [
            {
              id: "t9",
              slug: "cruce",
              name: "Cruce de Día",
              country: "AR",
              plan: "basico",
              created_at: "2024-03-10T02:30:00.000Z",
            },
          ],
        });
        const { default: AdminPage } = await import("./page");

        render(await AdminPage());

        expect(screen.getByText("10 mar 2024")).toBeInTheDocument();
        // La lectura local sería el 9: si aparece, el alta se está pintando en
        // la tz del servidor y la misma fila diría cosas distintas según dónde
        // corra el render.
        expect(screen.queryByText("9 mar 2024")).toBeNull();
      },
    );
  });

  /**
   * Una fecha impresentable se lleva puesta UNA fila, no la lista entera.
   *
   * `created_at` llega como `string` por un cast sin validar; ante algo que no
   * se puede parsear, `format` tira `RangeError`. Como `altaLabel` corre
   * adentro del `map`, esa excepción sube por toda la página: el dueño de la
   * plataforma pierde la vista de sus cien negocios por culpa de uno solo. Lo
   * que se afirma acá es que la fila vecina SIGUE en pantalla, que es la parte
   * que se rompería sin el guard.
   */
  it(
    "degrada una fecha ilegible a un guion sin tumbar el resto de la lista",
    { timeout: 15000 },
    async () => {
      const { listAllTenants } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(listAllTenants).mockResolvedValue({
        ok: true,
        value: [
          {
            id: "t8",
            slug: "roto",
            name: "Negocio Roto",
            country: "AR",
            plan: "basico",
            created_at: "no-es-una-fecha",
          },
          {
            id: "t7",
            slug: "sano",
            name: "Negocio Sano",
            country: "AR",
            plan: "pro",
            created_at: "2026-08-01T00:00:00Z",
          },
        ],
      });
      const { default: AdminPage } = await import("./page");

      render(await AdminPage());

      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(screen.getByText("Negocio Roto")).toBeInTheDocument();
      expect(screen.getByText("Negocio Sano")).toBeInTheDocument();
      expect(screen.getByText("—")).toBeInTheDocument();
    },
  );

  /**
   * El fallo tiene que VERSE y no puede parecerse al vacío. Es toda la razón
   * por la que `listAllTenants` devuelve un `Result`: si la consulta se cae y
   * la pantalla dice "todavía no hay negocios", le está mintiendo al dueño de
   * la plataforma sobre su propio negocio.
   */
  it(
    "muestra el error sin disfrazarlo de plataforma vacía",
    { timeout: 15000 },
    async () => {
      const { listAllTenants } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(listAllTenants).mockResolvedValue({
        ok: false,
        error: {
          code: "admin_tenants_query_failed",
          message: "No pudimos cargar los negocios de la plataforma.",
        },
      });
      const { default: AdminPage } = await import("./page");

      render(await AdminPage());

      expect(
        screen.getByText("No pudimos cargar los negocios de la plataforma."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/todavía no hay ningún negocio/i)).toBeNull();
    },
  );

  it(
    "avisa que la plataforma está vacía, sin cartel de error",
    { timeout: 15000 },
    async () => {
      const { listAllTenants } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(listAllTenants).mockResolvedValue({ ok: true, value: [] });
      const { default: AdminPage } = await import("./page");

      render(await AdminPage());

      expect(
        screen.getByText(/todavía no hay ningún negocio/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/no pudimos cargar/i)).toBeNull();
    },
  );

  /**
   * Sin este link el detalle es inalcanzable: no hay buscador ni ninguna otra
   * forma de llegar salvo tipear /admin/<slug> a mano.
   *
   * Se apunta al slug y no al id porque el slug es lo que el operador tiene a
   * la vista y lo que puede tipear; un uuid en la barra no le dice nada a nadie.
   */
  it(
    "hace clickeable cada negocio hacia su detalle",
    { timeout: 15000 },
    async () => {
      const { listAllTenants } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(listAllTenants).mockResolvedValue({ ok: true, value: tenants });
      const { default: AdminPage } = await import("./page");

      render(await AdminPage());

      expect(
        screen.getByRole("link", { name: /Barbería Vieja/ }),
      ).toHaveAttribute("href", "/admin/viejo");
      expect(
        screen.getByRole("link", { name: /Peluquería Nueva/ }),
      ).toHaveAttribute("href", "/admin/nuevo");
    },
  );

  /**
   * El operador ahora ATERRIZA acá al ingresar, y esta pantalla no tiene menú
   * lateral ni ninguna otra navegación: sin este botón, la única forma de
   * cerrar sesión sería borrar la cookie a mano.
   *
   * Se prueba en la salida vacía a propósito. Es el estado en el que un botón
   * de salir es más fácil de olvidar, y el que ve un operador nuevo en una
   * plataforma recién montada.
   */
  it(
    "deja cerrar sesión aunque no haya ningún negocio para mostrar",
    { timeout: 15000 },
    async () => {
      const { listAllTenants } = await import(
        "@/modules/admin/application/queries"
      );
      vi.mocked(listAllTenants).mockResolvedValue({ ok: true, value: [] });
      const { default: AdminPage } = await import("./page");

      render(await AdminPage());

      expect(screen.getByRole("button", { name: /salir/i })).toBeInTheDocument();
    },
  );

  /**
   * Sin este link, /admin/cupones sólo se alcanza tipeando la URL — el mismo
   * agujero que tenía /admin antes de que el login llevara ahí.
   */
  it("deja llegar a los cupones", { timeout: 15000 }, async () => {
    const { default: AdminPage } = await import("./page");

    render(await AdminPage());

    expect(screen.getByRole("link", { name: /cupones/i })).toHaveAttribute(
      "href",
      "/admin/cupones",
    );
  });
});
