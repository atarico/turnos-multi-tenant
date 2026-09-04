import { appError, err, ok, type Result } from "@/core/result";
import { createClient } from "@/lib/supabase/server";

import type { Subscription } from "../domain/subscription";
import { type SubscriptionRow, toSubscription } from "../domain/subscription-mapper";

/**
 * Estados en los que una suscripción está VIVA.
 *
 * `past_due` entra: el cobro falló pero el servicio sigue andando durante la
 * gracia. Dejarlo afuera cortaría el acceso por una tarjeta vencida, que es
 * exactamente lo que no queremos hacerle a un negocio que está atendiendo
 * gente. Espeja el índice único parcial `subscriptions_one_live_per_tenant`.
 */
const LIVE_STATUSES = ["trialing", "active", "past_due"] as const;

const COLUMNS =
  "id, tenant_id, plan, status, current_period_start, current_period_end, " +
  "trial_ends_at, price_usd_cents, charged_amount_cents, charged_currency, " +
  "fx_rate, fx_source, fx_quoted_at";

/**
 * La suscripción del negocio, o `null` si no tiene ninguna.
 *
 * NO FILTRA POR ESTADO, y conviene entender por qué antes de "arreglarlo".
 * Con el filtro de estados vivos, un negocio dado de baja leía `null` —
 * indistinguible de no tener suscripción— y las dos pantallas que dependen de
 * esto quedaban mintiendo: el panel no podía decirle hasta cuándo le queda
 * servicio, y `nueva-reserva` volvía a mostrarle el formulario apenas venciera
 * el período, para que la base se lo rechazara al enviar.
 *
 * Acá se trae el HECHO; qué significa cada estado lo decide el dominio, en
 * `takesNewBookings`. La que sí conserva el filtro estricto es
 * `getLiveSubscriptionIdForCharge`, que está justo abajo y existe aparte
 * precisamente por esto: cobrar sobre una suscripción dada de baja es lo único
 * que no puede pasar.
 *
 * Trae LA MÁS NUEVA. Hoy hay una sola fila por negocio, pero el índice único
 * parcial sólo prohíbe dos VIVAS: una baja más un alta posterior son dos filas
 * legales, y sin el orden `maybeSingle()` se rompería contra ellas.
 *
 * Devuelve `null` ante CUALQUIER fallo, incluida una excepción. Es una
 * decisión de encuadre: esto alimenta un cartel informativo en el panel, y el
 * panel la mete en un `Promise.all` — una promesa rechazada ahí se lleva
 * puesta la pantalla entera por un cartel decorativo. Por eso el `try` abarca
 * también la creación del cliente y no sólo la consulta: mirar únicamente el
 * `error` de PostgREST dejaba afuera justo el camino que rompe.
 *
 * El día que algo COBRE en base a esto, ese algo necesita un camino de error
 * propio y no puede reusar esta función: acá un fallo es indistinguible de
 * "no tiene suscripción", y para cobrar esa diferencia es todo.
 */
export async function getCurrentSubscription(
  tenantId: string,
): Promise<Subscription | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("subscriptions")
      .select(COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return toSubscription(data as unknown as SubscriptionRow);
  } catch {
    return null;
  }
}

/**
 * El id de la suscripción viva del negocio, para atarle un cobro.
 *
 * Es una función APARTE de `getCurrentSubscription` y no un parámetro suyo,
 * porque lo que cambia no es el filtro sino el contrato de error. Allá arriba
 * un fallo de base y "este negocio no tiene suscripción" son el mismo `null`,
 * que es lo correcto para un cartel del panel y es inaceptable acá: cobrar
 * sobre la suposición equivocada de las dos es abrir una suscripción que no se
 * puede atar a nada, o no abrirla cuando sí correspondía.
 *
 * Devuelve sólo el id: es lo único que el checkout necesita, y traer la fila
 * entera invitaría a decidir cosas sobre datos que van a cambiar entre esta
 * lectura y el momento en que el webhook confirme el cobro.
 */
export async function getLiveSubscriptionIdForCharge(
  tenantId: string,
): Promise<Result<string>> {
  let data: { id: string } | null;
  try {
    const supabase = await createClient();
    // El `try` abarca también la creación del cliente, no sólo la consulta:
    // mirar únicamente el `error` de PostgREST deja afuera justo el camino que
    // rompe cuando falta configuración. Mismo aprendizaje que el de arriba.
    const result = await supabase
      .from("subscriptions")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("status", LIVE_STATUSES)
      .maybeSingle();

    if (result.error) {
      return err(
        appError(
          "subscription_query_failed",
          "No pudimos leer tu suscripción. Intentá de nuevo en un momento.",
        ),
      );
    }
    data = result.data;
  } catch {
    return err(
      appError(
        "subscription_query_failed",
        "No pudimos leer tu suscripción. Intentá de nuevo en un momento.",
      ),
    );
  }

  if (!data) {
    return err(
      appError(
        "subscription_not_found",
        "Tu negocio no tiene una suscripción activa. Volvé a ingresar.",
      ),
    );
  }

  return ok(data.id);
}

/** Lo que hace falta para dar de baja: nuestra fila y la de la pasarela. */
export interface LiveSubscriptionForCancel {
  id: string;
  /**
   * `null` cuando el negocio nunca llegó a pagar: está en la prueba y no pasó
   * por el checkout, así que del lado de Mercado Pago no hay nada abierto. No
   * es un error y quien llama tiene que poder distinguirlo — pedirle a la
   * pasarela que cancele algo que no existe da 404, que se lee como "rechazó
   * la solicitud" y frenaría una baja perfectamente legítima.
   */
  providerSubscriptionId: string | null;
}

/**
 * La suscripción viva del negocio, para darla de baja.
 *
 * Filtra por estados VIVOS igual que `getLiveSubscriptionIdForCharge` y por la
 * misma razón de fondo: acá tampoco sirve el `null` ambiguo de
 * `getCurrentSubscription`. Dar de baja "por las dudas" sobre un fallo de
 * lectura, o decirle a alguien que no tiene suscripción porque la base no
 * contestó, son los dos errores que este `Result` existe para evitar.
 *
 * Es una función aparte de la del cobro y no un parámetro suyo porque lo que
 * necesita es distinto: el cobro quiere sólo el id nuestro, y la baja necesita
 * además el de la pasarela, que es a quien hay que ir a cortarle el débito.
 */
export async function getLiveSubscriptionForCancel(
  tenantId: string,
): Promise<Result<LiveSubscriptionForCancel>> {
  let data: { id: string; provider_subscription_id: string | null } | null;
  try {
    const supabase = await createClient();
    const result = await supabase
      .from("subscriptions")
      .select("id, provider_subscription_id")
      .eq("tenant_id", tenantId)
      .in("status", LIVE_STATUSES)
      .maybeSingle();

    if (result.error) {
      return err(
        appError(
          "subscription_query_failed",
          "No pudimos leer tu suscripción. Intentá de nuevo en un momento.",
        ),
      );
    }
    data = result.data;
  } catch {
    return err(
      appError(
        "subscription_query_failed",
        "No pudimos leer tu suscripción. Intentá de nuevo en un momento.",
      ),
    );
  }

  if (!data) {
    return err(
      appError(
        "subscription_not_found",
        "Tu negocio no tiene una suscripción activa para dar de baja.",
      ),
    );
  }

  return ok({
    id: data.id,
    providerSubscriptionId: data.provider_subscription_id,
  });
}

/**
 * Cuántos turnos CARGÓ el negocio dentro de la ventana, o `null` si no se pudo
 * contar.
 *
 * El conteo lo hace Postgres (`count_period_bookings`) y no esta función, por
 * lo mismo que `sumMonthlyRevenue`: traer las filas para contarlas acá se
 * rompe contra el `max_rows` de PostgREST, que recorta la respuesta en 1000
 * filas SIN devolver error. Y el recorte pegaría justo en el único caso que
 * importa — el negocio que se pasó del techo es, por definición, el que tiene
 * más filas que nadie.
 *
 * **Devuelve `null` ante cualquier fallo, y eso NO es lo mismo que cero.**
 * Cero significa "no cargaste nada" y es una respuesta; `null` significa "no
 * sabemos". Colapsarlos le diría al dueño que va tranquilo justo cuando no
 * podemos afirmarlo, que es la única forma de que este aviso mienta.
 *
 * El `try` abarca también la creación del cliente y no sólo la consulta: esto
 * viaja en el mismo `Promise.all` que `getCurrentSubscription`, donde una
 * promesa rechazada se lleva puesta la pantalla entera por un cartel.
 */
export async function countPeriodBookings(
  tenantId: string,
  periodStartIso: string,
  periodEndIso: string,
): Promise<number | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("count_period_bookings", {
      p_tenant_id: tenantId,
      p_start: periodStartIso,
      p_end: periodEndIso,
    });

    if (error || typeof data !== "number") return null;
    return data;
  } catch {
    return null;
  }
}
