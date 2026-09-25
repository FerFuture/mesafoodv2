import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useLocation, matchPath } from "react-router-dom";
import { supabase } from "../supabaseClient";
import { fetchRestaurantForDashboard } from "../lib/restaurantTenant";
import { currency } from "../lib/format";

function buildCartLines(cartById, menuById) {
  const names = [];
  for (const [id, qty] of Object.entries(cartById)) {
    const item = menuById.get(id);
    if (!item || qty < 1) continue;
    const label = String(item.name || "").trim();
    if (!label) continue;
    for (let i = 0; i < qty; i += 1) names.push(label);
  }
  return names;
}

function cartTotal(cartById, menuById) {
  let t = 0;
  for (const [id, qty] of Object.entries(cartById)) {
    const item = menuById.get(id);
    if (!item || qty < 1) continue;
    const p = Number(item.price);
    if (!Number.isFinite(p) || p <= 0) continue;
    t += p * qty;
  }
  return Math.round(t * 100) / 100;
}

function groupMenuByCategory(menuItems) {
  const byCat = new Map();
  for (const it of menuItems || []) {
    const cat = String(it.category || "Otros").trim() || "Otros";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(it);
  }
  const entries = Array.from(byCat.entries()).map(([cat, items]) => [
    cat,
    [...items].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "es", {
        sensitivity: "base",
        numeric: true
      })
    )
  ]);
  entries.sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]), "es", { sensitivity: "base", numeric: true })
  );
  return entries;
}

function normalizeCategoryMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function shouldHideMesaQrCategory(category) {
  const normalized = normalizeCategoryMatchText(category);
  if (!normalized) return false;
  return normalized.includes("calle") || normalized.includes("llevar");
}

function normalizeBlockedMesaTables(value, maxTableCount = 500) {
  if (!Array.isArray(value)) return [];
  const max = Number.isFinite(maxTableCount) && maxTableCount >= 1 ? Math.floor(maxTableCount) : 500;
  return [...new Set(value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= max))]
    .sort((a, b) => a - b);
}

const MESA_QR_TOKEN_REQUIRED = true;
/** Pedido a cocina puede ir por proxy Vercel → VPS; algo más alto que antes. */
const API_REQUEST_TIMEOUT_MS = 15000;

export default function MesaClientApp() {
  const { tableNumber } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const mesaTokenFromUrl = String(searchParams.get("t") || "").trim();

  const cartaRoute = Boolean(matchPath("/carta", location.pathname));
  const viewOnly = cartaRoute && String(searchParams.get("ver") || "") === "1";

  const parsedTableNumber = useMemo(() => {
    if (cartaRoute) {
      const n = parseInt(String(searchParams.get("mesa") || "").trim(), 10);
      return Number.isFinite(n) && n >= 1 ? n : null;
    }
    const n = parseInt(String(tableNumber || "").trim(), 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }, [cartaRoute, searchParams, tableNumber]);

  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [blockedTables, setBlockedTables] = useState([]);

  const [mesaEnabled, setMesaEnabled] = useState(false);
  const [menuItems, setMenuItems] = useState([]);
  const [menuSearchQuery, setMenuSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [cartById, setCartById] = useState({});
  const [observacion, setObservacion] = useState("");
  const [visit, setVisit] = useState(null);
  const [qrOpen, setQrOpen] = useState(true);
  const [visitError, setVisitError] = useState("");
  const [accountClosed, setAccountClosed] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const [confirmDialog, setConfirmDialog] = useState(null);
  const confirmResolverRef = useRef(null);

  const visibleMenuItems = useMemo(
    () =>
      viewOnly ? menuItems : menuItems.filter((item) => !shouldHideMesaQrCategory(item?.category)),
    [menuItems, viewOnly]
  );

  const menuById = useMemo(() => {
    const m = new Map();
    for (const it of visibleMenuItems) {
      if (it?.id) m.set(it.id, it);
    }
    return m;
  }, [visibleMenuItems]);

  const cartLines = useMemo(() => buildCartLines(cartById, menuById), [cartById, menuById]);
  const totalAmount = useMemo(() => cartTotal(cartById, menuById), [cartById, menuById]);

  const menuItemsFiltered = useMemo(() => {
    const raw = String(menuSearchQuery || "").trim().toLowerCase();
    if (!raw) return visibleMenuItems;

    const words = raw.split(/\s+/).filter(Boolean);
    return visibleMenuItems.filter((item) => {
      const haystack = [
        item.name,
        item.category,
        item.description,
        item.price != null ? String(item.price) : ""
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [menuSearchQuery, visibleMenuItems]);

  const groupedMenu = useMemo(() => groupMenuByCategory(menuItemsFiltered), [menuItemsFiltered]);
  const mesaBlocked = parsedTableNumber != null && blockedTables.includes(parsedTableNumber);

  function buildMesaApiCandidates() {
    const origin = window.location.origin.replace(/\/$/, "");
    return [`${origin}/api/mesa/order`];
  }

  async function fetchWithTimeout(url, options, timeoutMs = API_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  useEffect(() => {
    async function run() {
      setLoading(true);
      setError("");
      try {
        const { data, error: queryError } = await fetchRestaurantForDashboard(supabase);
        if (queryError) throw queryError;
        if (!data) {
          setError("No se encontró el restaurante para este panel.");
          return;
        }
        setRestaurantId(data.id);
        setRestaurantName(data.name || "");

        const metadataObj =
          data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
            ? data.metadata
            : {};
        setMesaEnabled(metadataObj.mesa_qr_enabled !== false);
        setBlockedTables(normalizeBlockedMesaTables(metadataObj.mesa_qr_blocked_tables, Number(data.table_count) || 500));
      } catch (e) {
        setError(`Error cargando restaurante: ${e?.message || e}`);
      }

      setLoading(false);
    }
    run();
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;

    async function loadMenu() {
      setError("");
      setLoading(true);
      try {
        const { data, error: queryError } = await supabase
          .from("menu_items")
          .select("id, name, price, category, description")
          .eq("restaurant_id", restaurantId)
          .eq("available", true)
          .order("name", { ascending: true });
        if (queryError) throw queryError;
        setMenuItems(data || []);
      } catch (e) {
        setError(`Error cargando menú: ${e?.message || e}`);
      } finally {
        setLoading(false);
      }
    }
    loadMenu();
  }, [restaurantId]);

  useEffect(() => {
    if (viewOnly || !restaurantId || !parsedTableNumber || !mesaTokenFromUrl) return undefined;
    let cancelled = false;
    setVisit(null);
    setVisitError("");
    setAccountClosed(false);

    async function openVisit() {
      try {
        const origin = window.location.origin.replace(/\/$/, "");
        const res = await fetchWithTimeout(`${origin}/api/mesa/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            restaurantId,
            tableNumber: parsedTableNumber,
            mesaToken: mesaTokenFromUrl
          })
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `Error HTTP ${res.status}`);
        if (!cancelled) {
          setVisit({
            openedAt: String(data?.openedAt || ""),
            visitToken: String(data?.visitToken || "")
          });
          setQrOpen(data?.qrOpen !== false);
        }
      } catch (e) {
        if (!cancelled) setVisitError(e?.message || "No se pudo abrir la mesa");
      }
    }

    openVisit();
    return () => {
      cancelled = true;
    };
  }, [viewOnly, restaurantId, parsedTableNumber, mesaTokenFromUrl]);

  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [toast]);

  function requestConfirm({
    title = "Confirmar acción",
    message = "",
    body = null,
    confirmLabel = "Confirmar",
    cancelLabel = "Cancelar",
    tone = "info"
  } = {}) {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message, body, confirmLabel, cancelLabel, tone });
    });
  }

  function handleConfirmDialog(value) {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    if (typeof resolver === "function") resolver(Boolean(value));
  }

  function addToCart(itemId) {
    setCartById((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] || 0) + 1
    }));
  }

  function removeFromCart(itemId) {
    setCartById((prev) => {
      const next = { ...prev };
      const q = (next[itemId] || 0) - 1;
      if (q < 1) delete next[itemId];
      else next[itemId] = q;
      return next;
    });
  }

  async function performSubmitOrder(tableNum) {
    setError("");
    setSubmitting(true);
    try {
      const payload = {
        restaurantId,
        tableNumber: tableNum,
        items: cartLines,
        mesaToken: mesaTokenFromUrl || "",
        observacion: String(observacion || "").trim(),
        openedAt: visit?.openedAt || "",
        visitToken: visit?.visitToken || ""
      };
      const apiCandidates = buildMesaApiCandidates();
      let res = null;
      let lastNetworkError = null;
      for (const candidate of apiCandidates) {
        try {
          const probe = await fetchWithTimeout(candidate, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          // Solo reintentar cuando no existe la ruta (404) o el host rechaza POST por SPA (405).
          // Errores 502/503 del proxy de Vercel deben mostrarse (mensaje de configuración / backend).
          if ([404, 405].includes(probe.status)) continue;
          res = probe;
          break;
        } catch (err) {
          if (err?.name === "AbortError") {
            lastNetworkError = new Error(`Timeout de conexión (${API_REQUEST_TIMEOUT_MS}ms) en ${candidate}`);
          } else {
            lastNetworkError = err;
          }
        }
      }
      if (!res) {
        throw new Error(
          `No se pudo conectar con la API. Revisá URL base/puertos (${apiCandidates.join(" | ")}). ${
            lastNetworkError?.message || ""
          }`
        );
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (data?.code === "visit_closed") setAccountClosed(true);
        if (data?.code === "table_locked") setQrOpen(false);
        const msg = data?.error || `Error HTTP ${res.status}`;
        throw new Error(msg);
      }

      setCartById({});
      setObservacion("");
      setQrOpen(true);
      setToast("Listo · enviado a cocina");
    } catch (e) {
      setError(`No se pudo enviar el pedido: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitOrder() {
    setError("");

    if (!parsedTableNumber) {
      setError("Mesa inválida.");
      return;
    }
    if (MESA_QR_TOKEN_REQUIRED && !mesaTokenFromUrl) {
      setError("Este enlace no es válido. Escaneá el código QR de tu mesa.");
      return;
    }
    if (mesaBlocked) {
      setError(`La mesa ${parsedTableNumber} está bloqueada para pedidos QR. Consultá al personal.`);
      return;
    }
    if (!restaurantId) {
      setError("Falta configuración del restaurante.");
      return;
    }
    if (accountClosed) {
      setError("La cuenta de esta mesa ya se cerró. Si seguís en la mesa, escaneá el QR otra vez.");
      return;
    }
    if (!visit?.openedAt || !visit?.visitToken) {
      setError("Todavía no se abrió la visita de la mesa. Esperá un segundo o volvé a escanear el QR.");
      return;
    }
    if (cartLines.length === 0) {
      setError("Agregá al menos un producto al pedido.");
      return;
    }

    const observacionTrimmed = String(observacion || "").trim();
    const summaryLines = [];
    for (const [itemId, qty] of Object.entries(cartById)) {
      const item = menuById.get(itemId);
      if (!item || qty < 1) continue;
      const p = Number(item.price);
      const lineTotal = Number.isFinite(p) ? Math.round(p * qty * 100) / 100 : 0;
      summaryLines.push({
        key: itemId,
        name: String(item.name || "").trim() || "Ítem",
        qty,
        lineTotal
      });
    }

    const confirmed = await requestConfirm({
      title: "Confirmar envío a cocina",
      message: "Revisá el pedido. Si está bien, tocá enviar para mandarlo a cocina.",
      confirmLabel: "Sí, enviar a cocina",
      cancelLabel: "Volver a editar",
      tone: "info",
      body: (
        <div className="mt-3 space-y-3 border-t border-slate-700/80 pt-3 text-left">
          <p className="text-sm">
            <span className="text-slate-500">Mesa</span>{" "}
            <span className="font-semibold text-white">{parsedTableNumber}</span>
          </p>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Ítems</p>
            <ul className="mt-1 max-h-52 space-y-1 overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-950/50 px-3 py-2 text-sm text-slate-200">
              {summaryLines.map(({ key, name, qty, lineTotal }) => (
                <li key={key} className="flex flex-wrap justify-between gap-x-2 gap-y-0.5">
                  <span>
                    <span className="font-medium text-emerald-100/90">{name}</span>
                    <span className="text-slate-500"> × {qty}</span>
                  </span>
                  <span className="tabular-nums text-slate-400">{currency(lineTotal)}</span>
                </li>
              ))}
            </ul>
          </div>
          {observacionTrimmed ? (
            <p className="text-sm">
              <span className="text-slate-500">Observación</span>{" "}
              <span className="font-medium text-amber-100">{observacionTrimmed}</span>
            </p>
          ) : null}
          <p className="flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-700/60 pt-2 text-sm">
            <span className="text-slate-500">Total del pedido</span>
            <span className="text-lg font-bold tabular-nums text-emerald-300">{currency(totalAmount)}</span>
          </p>
        </div>
      )
    });

    if (!confirmed) return;

    await performSubmitOrder(parsedTableNumber);
  }

  if (parsedTableNumber == null && !viewOnly) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <p className="text-lg font-semibold text-slate-100">
            {cartaRoute ? "Falta el enlace de tu mesa" : "Mesa inválida"}
          </p>
          <p className="mt-2 text-sm text-slate-400">
            {cartaRoute
              ? "Para ver la carta y pedir con el número de mesa correcto, escaneá el código QR que está en la mesa (o abrí el enlace completo que incluye mesa y token)."
              : "El número de mesa en la dirección no es válido."}
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <p className="text-sm text-slate-300">Cargando…</p>
      </div>
    );
  }

  if (!mesaEnabled && !viewOnly) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <p className="text-lg font-semibold text-slate-100">Pedido en mesa deshabilitado</p>
          <p className="mt-2 text-sm text-slate-400">
            El módulo de carta QR está desactivado. Consultá con el personal.
          </p>
        </div>
      </div>
    );
  }

  if (!viewOnly && MESA_QR_TOKEN_REQUIRED && !mesaTokenFromUrl) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-amber-500/35 bg-slate-900/60 p-6 text-center">
          <p className="text-lg font-semibold text-amber-100">Enlace incompleto</p>
          <p className="mt-2 text-sm text-slate-400">
            Abrí este panel escaneando el código QR de tu mesa (no uses solo el número en la URL).
          </p>
        </div>
      </div>
    );
  }

  if (!viewOnly && mesaBlocked) {
    return (
      <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/35 bg-slate-900/60 p-6 text-center">
          <p className="text-lg font-semibold text-rose-100">Mesa bloqueada</p>
          <p className="mt-2 text-sm text-slate-300">
            La mesa {parsedTableNumber} no está habilitada para recibir pedidos desde la carta QR.
          </p>
          <p className="mt-2 text-sm text-slate-400">Consultá con el personal para habilitarla nuevamente.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-white">{restaurantName || "Restaurante"}</h1>
              <p className="text-xs text-slate-400">
                {viewOnly ? "Carta" : `Pedido para la mesa ${parsedTableNumber}`}
              </p>
            </div>
            {viewOnly ? null : (
            <div className="text-right">
              <p className="text-xs text-slate-500">Total</p>
              <p className="text-lg font-bold tabular-nums text-emerald-200">{currency(totalAmount)}</p>
            </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-5 space-y-5">
        {!viewOnly && !qrOpen && !accountClosed ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-100" role="status">
            Esta mesa no está habilitada. Pedile al mozo que la habilite y después volvé a enviar el pedido.
          </div>
        ) : null}

        {visitError && !accountClosed ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
            {visitError}
          </div>
        ) : null}

        {accountClosed ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-100" role="status">
            La cuenta de esta mesa ya se cerró. Desde este celular no se puede seguir pidiendo. Si seguís en la mesa, escaneá el QR otra vez.
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
            {error}
          </div>
        ) : null}

        {visibleMenuItems.length > 0 ? (
          <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <label className="block">
              <span className="sr-only">Buscar productos</span>
              <input
                type="search"
                value={menuSearchQuery}
                onChange={(e) => setMenuSearchQuery(e.target.value)}
                placeholder="Buscar por nombre, categoria, descripcion o precio..."
                autoComplete="off"
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
              />
            </label>
            {menuSearchQuery.trim() ? (
              <p className="text-xs text-slate-500">
                {menuItemsFiltered.length === visibleMenuItems.length
                  ? `${visibleMenuItems.length} productos`
                  : `${menuItemsFiltered.length} de ${visibleMenuItems.length} productos`}
              </p>
            ) : null}
          </section>
        ) : null}

        {visibleMenuItems.length > 0 && menuItemsFiltered.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-center text-slate-300">
            No hay productos que coincidan con &quot;{menuSearchQuery.trim()}&quot;.
          </div>
        ) : null}

        {menuItems.length > 0 && visibleMenuItems.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-center text-slate-300">
            No hay productos disponibles para mostrar en la carta de mesa.
          </div>
        ) : null}

        <section className="space-y-5">
          {groupedMenu.map(([category, items]) => (
            <div key={category} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{category}</h2>
              <div className="space-y-2">
                {items.map((item) => {
                  const q = cartById[item.id] || 0;
                  return (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700/80 bg-slate-900/40 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-100">{item.name}</p>
                        {item.description ? (
                          <p className="text-xs text-slate-400">{item.description}</p>
                        ) : null}
                        <p className="text-sm text-emerald-300/90">{currency(item.price)}</p>
                      </div>
                      {viewOnly ? null : (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={q < 1 || submitting || accountClosed}
                          onClick={() => removeFromCart(item.id)}
                          className="h-10 w-10 rounded-lg border border-slate-600 text-lg leading-none text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                        >
                          −
                        </button>
                        <span className="w-8 text-center tabular-nums text-lg font-semibold">{q}</span>
                        <button
                          type="button"
                          disabled={submitting || accountClosed}
                          onClick={() => addToCart(item.id)}
                          className="h-10 w-10 rounded-lg bg-emerald-600 text-lg font-semibold leading-none text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          +
                        </button>
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        {viewOnly ? null : (
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
          <label className="block text-xs font-medium uppercase tracking-wider text-slate-400">
            Observación <span className="normal-case tracking-normal text-slate-500">(opcional)</span>
          </label>
          <textarea
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            rows={2}
            maxLength={400}
            disabled={submitting}
            placeholder="Ej: sin mayonesa, sin cebolla, bien cocido…"
            className="mt-2 w-full resize-y rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500 focus:border-emerald-500/50 disabled:opacity-50"
          />
        </div>
        )}

        {viewOnly ? null : (
        <div className="sticky bottom-0 border-t border-slate-800 bg-slate-950/95 py-4 backdrop-blur">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-slate-400">Ítems</p>
                <p className="text-sm text-slate-200">{cartLines.length} producto(s)</p>
              </div>

              <div className="flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  disabled={submitting || accountClosed || cartLines.length === 0 || !visit?.visitToken}
                  onClick={() => submitOrder()}
                  className="rounded-lg bg-emerald-500 px-6 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  {submitting ? "Enviando…" : "Enviar a cocina"}
                </button>
              </div>
            </div>

          </div>
        </div>
        )}
      </main>

      {toast ? (
        <div
          className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 px-4"
          role="status"
          aria-live="polite"
        >
          <div className="pointer-events-none rounded-full border border-emerald-500/35 bg-emerald-950/90 px-4 py-2 text-center text-sm font-medium text-emerald-100 shadow-lg shadow-emerald-950/30 backdrop-blur-sm">
            {toast}
          </div>
        </div>
      ) : null}

      {confirmDialog ? (
        <ConfirmModal dialog={confirmDialog} onResolve={handleConfirmDialog} />
      ) : null}
    </div>
  );
}

const CONFIRM_TONE_PALETTE = {
  danger: {
    accent: "border-rose-500/40",
    iconBg: "bg-rose-500/20 text-rose-300",
    confirmBtn: "bg-rose-500 hover:bg-rose-400 text-slate-950"
  },
  warning: {
    accent: "border-amber-500/40",
    iconBg: "bg-amber-500/20 text-amber-300",
    confirmBtn: "bg-amber-500 hover:bg-amber-400 text-slate-950"
  },
  info: {
    accent: "border-blue-500/40",
    iconBg: "bg-blue-500/20 text-blue-300",
    confirmBtn: "bg-blue-500 hover:bg-blue-400 text-slate-950"
  }
};

function ConfirmModal({ dialog, onResolve }) {
  const palette = CONFIRM_TONE_PALETTE[dialog?.tone] || CONFIRM_TONE_PALETTE.info;

  useEffect(() => {
    function handleKey(event) {
      if (event.key === "Escape") onResolve(false);
      if (event.key === "Enter") onResolve(true);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onResolve]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mesa-client-confirm-title"
    >
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={() => onResolve(false)} />
      <div
        className={`relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border ${palette.accent} bg-slate-900/95 p-5 shadow-2xl shadow-black/40`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 flex-none items-center justify-center rounded-full ${palette.iconBg} text-base font-bold`}
            aria-hidden="true"
          >
            !
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="mesa-client-confirm-title" className="text-base font-semibold text-slate-100">
              {dialog.title}
            </h3>
            {dialog.message ? <p className="mt-1 text-sm text-slate-300">{dialog.message}</p> : null}
            {dialog.body ? dialog.body : null}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="rounded-lg border border-slate-600 bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
          >
            {dialog.cancelLabel || "Cancelar"}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => onResolve(true)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${palette.confirmBtn}`}
          >
            {dialog.confirmLabel || "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}
