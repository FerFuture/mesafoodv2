/** Igual que `database.js`: solo dígitos para comparar WhatsApp. */
export function whatsappDigits(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Variantes del número del bot (misma lógica que getPossibleIncomingNumbers en database.js). */
export function botNumberMatchCandidates(rawNumber) {
  const normalized = whatsappDigits(rawNumber);
  if (!normalized) return [];

  const variants = new Set([normalized]);

  if (normalized.startsWith("569") && normalized.length === 11) {
    variants.add(`56${normalized.slice(3)}`);
  } else if (normalized.startsWith("56") && normalized.length === 10) {
    variants.add(`569${normalized.slice(2)}`);
  }

  return [...variants];
}

function rowMatchesCandidates(row, candidateSet) {
  const d = whatsappDigits(row?.whatsapp_number);
  if (!d) return false;
  if (candidateSet.has(d)) return true;
  return botNumberMatchCandidates(d).some((v) => candidateSet.has(v));
}

const RESTAURANT_COLUMNS =
  "id, name, public_name, whatsapp_number, delivery_enabled, local_enabled, mesa_enabled, cash_enabled, mercadopago_enabled, stats_enabled, table_count, metadata, status";

function restaurantIdFromUrl() {
  if (typeof window === "undefined") return "";
  return String(new URLSearchParams(window.location.search).get("r") || "").trim();
}

function pausedResult() {
  return {
    data: null,
    error: { message: "Este local está pausado. El acceso vuelve cuando se reactive." }
  };
}

async function fetchRestaurantById(supabase, restaurantId) {
  const id = String(restaurantId || "").trim();
  if (!id) return { data: null, error: null };
  const { data, error } = await supabase
    .from("restaurants")
    .select(RESTAURANT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return { data: null, error };
  if (!data) return { data: null, error: null };
  if (String(data.status || "active") === "paused") return pausedResult();
  return { data, error: null };
}

/**
 * Resuelve la fila `restaurants` del panel.
 * - Carta pública: `?r=` es el id del local.
 * - Personal logueado: el `restaurantId` de la sesión.
 * - Compatibilidad con el bot: `VITE_BOT_WHATSAPP_NUMBER`, si está definido.
 */
export async function fetchRestaurantForDashboard(supabase) {
  const fromUrl = restaurantIdFromUrl();
  if (fromUrl) return fetchRestaurantById(supabase, fromUrl);

  let sessionRestaurantId = "";
  try {
    const raw = localStorage.getItem("restobot_session_v1");
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.role && parsed.role !== "owner" && parsed.restaurantId) {
      sessionRestaurantId = String(parsed.restaurantId);
    }
  } catch {
    sessionRestaurantId = "";
  }
  if (sessionRestaurantId) return fetchRestaurantById(supabase, sessionRestaurantId);

  const configuredRaw = import.meta.env.VITE_BOT_WHATSAPP_NUMBER ?? "";
  const candidates = botNumberMatchCandidates(configuredRaw);

  if (candidates.length > 0) {
    const candidateSet = new Set(candidates);

    const { data: rowsIn, error: errIn } = await supabase
      .from("restaurants")
      .select(RESTAURANT_COLUMNS)
      .in("whatsapp_number", candidates);

    if (errIn) return { data: null, error: errIn };

    const firstExact = (rowsIn || [])[0];
    if (firstExact) {
      if (String(firstExact.status || "active") === "paused") return pausedResult();
      return { data: firstExact, error: null };
    }

    const { data: rowsScan, error: errScan } = await supabase
      .from("restaurants")
      .select(RESTAURANT_COLUMNS)
      .order("id", { ascending: true })
      .limit(200);

    if (errScan) return { data: null, error: errScan };

    const fallback = (rowsScan || []).find((row) => rowMatchesCandidates(row, candidateSet));
    if (!fallback) return { data: null, error: null };
    if (String(fallback.status || "active") === "paused") return pausedResult();
    return { data: fallback, error: null };
  }

  return { data: null, error: null };
}
