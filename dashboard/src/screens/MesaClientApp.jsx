import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useLocation, matchPath } from "react-router-dom";
import { supabase } from "../supabaseClient";
import { fetchRestaurantForDashboard } from "../lib/restaurantTenant";
import { currency } from "../lib/format";
import { readMenuStock, writeMenuStockTags } from "../lib/menuStock";
import "./../components/carta/carta.css";
import { COPY } from "../components/carta/copy";
import { categoryDomId, dishMarks, displayDishName, formatMenuPrice } from "../components/carta/cartaFormat";
import CartaHeader, { CartaFrame, CartaNotice } from "../components/carta/CartaHeader";
import CategoryNav from "../components/carta/CategoryNav";
import DishCard from "../components/carta/DishCard";
import DishModal from "../components/carta/DishModal";
import CartaFooter, { WhatsappFab } from "../components/carta/CartaFooter";

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
  const headerRef = useRef(null);
  const navRef = useRef(null);
  const rootRef = useRef(null);
  const [place, setPlace] = useState({ address: "", openingHours: "", whatsapp: "" });
  const [selectedId, setSelectedId] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [dietFilter, setDietFilter] = useState("");
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("carta_theme_v1") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem("carta_lang_v1") === "en" ? "en" : "es";
    } catch {
      return "es";
    }
  });
  const copy = COPY[lang] || COPY.es;

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
    const words = raw ? raw.split(/\s+/).filter(Boolean) : [];
    return visibleMenuItems.filter((item) => {
      if (words.length) {
        const haystack = [item.name, item.category, item.description, item.price != null ? String(item.price) : ""]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return false;
      }
      if (dietFilter && !dishMarks(item).includes(dietFilter)) return false;
      return true;
    });
  }, [menuSearchQuery, visibleMenuItems, dietFilter]);

  const dietOptions = useMemo(() => {
    const found = new Set();
    for (const item of visibleMenuItems) {
      for (const mark of dishMarks(item)) found.add(mark);
    }
    return ["vegetariano", "sintacc", "picante"].filter((id) => found.has(id));
  }, [visibleMenuItems]);

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
        try {
          const { data: extra, error: extraError } = await supabase
            .from("restaurants")
            .select("public_name, address, opening_hours, whatsapp_number")
            .eq("id", data.id)
            .maybeSingle();
          if (!extraError && extra) {
            if (extra.public_name) setRestaurantName(extra.public_name);
            setPlace({
              address: extra.address || "",
              openingHours: extra.opening_hours || "",
              whatsapp: String(extra.whatsapp_number || "").replace(/\D/g, "")
            });
          }
        } catch {
          /* La carta se muestra igual si no se puede leer el pie. */
        }

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
          .select("id, name, price, category, description, tags, available")
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

  useEffect(() => {
    const prev = document.title;
    document.title = restaurantName ? `${restaurantName} · Carta` : "Carta";
    return () => {
      document.title = prev;
    };
  }, [restaurantName]);

  useEffect(() => {
    const names = groupedMenu.map(([category]) => category);
    if (!names.length) return undefined;
    function onScroll() {
      const line = (headerRef.current?.offsetHeight || 0) + (navRef.current?.offsetHeight || 0) + 8;
      let current = names[0];
      for (const name of names) {
        const el = document.getElementById(categoryDomId(name));
        if (el && el.getBoundingClientRect().top <= line) current = name;
      }
      setActiveCategory(current);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [groupedMenu]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const apply = () => {
      const headerH = headerRef.current?.offsetHeight || 0;
      const navH = navRef.current?.offsetHeight || 0;
      root.style.setProperty("--header", `${headerH}px`);
      root.style.setProperty("--offset", `${headerH + navH + 8}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    if (headerRef.current) observer.observe(headerRef.current);
    if (navRef.current) observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [loading, groupedMenu.length, restaurantName]);

  useEffect(() => {
    const main = document.getElementById("carta-main");
    if (!main) return undefined;
    if (selectedId) main.setAttribute("inert", "");
    else main.removeAttribute("inert");
    return () => main.removeAttribute("inert");
  }, [selectedId]);

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem("carta_theme_v1", next);
      } catch {
        /* La preferencia queda solo en esta visita. */
      }
      return next;
    });
  }

  function toggleLang() {
    setLang((prev) => {
      const next = prev === "es" ? "en" : "es";
      try {
        localStorage.setItem("carta_lang_v1", next);
      } catch {
        /* La preferencia queda solo en esta visita. */
      }
      return next;
    });
  }

  function scrollToCategory(category) {
    const el = document.getElementById(categoryDomId(category));
    if (!el) return;
    setActiveCategory(category);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
    const item = menuById.get(itemId);
    const stock = readMenuStock(item);
    setCartById((prev) => {
      const current = prev[itemId] || 0;
      if (stock != null && current >= stock) return prev;
      return { ...prev, [itemId]: current + 1 };
    });
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

      setMenuItems((prev) =>
        prev
          .map((item) => {
            const qty = cartById[item.id] || 0;
            const stock = readMenuStock(item);
            if (!qty || stock == null) return item;
            const next = Math.max(0, stock - qty);
            if (next <= 0) return null;
            return { ...item, tags: writeMenuStockTags(item.tags, next), available: true };
          })
          .filter(Boolean)
      );
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
      <CartaNotice theme={theme} lang={lang} title={cartaRoute ? "Falta el enlace de tu mesa" : "Mesa inválida"}>
        {cartaRoute
          ? "Para ver la carta y pedir con el número de mesa correcto, escaneá el código QR que está en la mesa (o abrí el enlace completo que incluye mesa y token)."
          : "El número de mesa en la dirección no es válido."}
      </CartaNotice>
    );
  }

  if (loading) {
    return (
      <CartaFrame theme={theme} lang={lang}>
        <div className="mx-auto w-full max-w-[1100px] space-y-3 px-4 py-6">
          <p className="sr-only">{copy.loading}</p>
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-28 animate-pulse rounded-2xl bg-[var(--surface)]" />
          ))}
        </div>
      </CartaFrame>
    );
  }

  if (!mesaEnabled && !viewOnly) {
    return (
      <CartaNotice theme={theme} lang={lang} title="Pedido en mesa deshabilitado">
        El módulo de carta QR está desactivado. Consultá con el personal.
      </CartaNotice>
    );
  }

  if (!viewOnly && MESA_QR_TOKEN_REQUIRED && !mesaTokenFromUrl) {
    return (
      <CartaNotice theme={theme} lang={lang} title="Enlace incompleto">
        Abrí este panel escaneando el código QR de tu mesa (no uses solo el número en la URL).
      </CartaNotice>
    );
  }

  if (!viewOnly && mesaBlocked) {
    return (
      <CartaNotice theme={theme} lang={lang} title="Mesa bloqueada">
        La mesa {parsedTableNumber} no está habilitada para recibir pedidos desde la carta QR. Consultá con el personal para habilitarla nuevamente.
      </CartaNotice>
    );
  }

  const selectedItem = selectedId ? menuById.get(selectedId) || null : null;
  const categories = groupedMenu.map(([category]) => category);
  const headerName = restaurantName || "Restaurante";
  const headerSubtitle = viewOnly
    ? place.openingHours
      ? `${copy.carta} · ${place.openingHours}`
      : copy.carta
    : `${copy.mesa} ${parsedTableNumber} · ${copy.carta}`;

  return (
    <CartaFrame ref={rootRef} theme={theme} lang={lang}>
      <div id="carta-main">
      <CartaHeader
        headerRef={headerRef}
        name={headerName}
        subtitle={headerSubtitle}
        theme={theme}
        lang={lang}
        copy={copy}
        onToggleTheme={toggleTheme}
        onToggleLang={toggleLang}
      />
      <CategoryNav
        navRef={navRef}
        categories={categories}
        active={activeCategory}
        onSelect={scrollToCategory}
        copy={copy}
      />
      <main className={viewOnly ? "" : "pb-28"}>
        <div className="mx-auto w-full max-w-[1100px] space-y-4 px-4 pt-4">
          {!viewOnly && !qrOpen && !accountClosed ? (
            <div className="rounded-2xl bg-amber-500/15 px-3 py-3 text-sm text-[var(--text)]" role="status">
              Esta mesa no está habilitada. Pedile al mozo que la habilite y después volvé a enviar el pedido.
            </div>
          ) : null}
          {visitError && !accountClosed ? (
            <div className="rounded-2xl bg-rose-500/15 px-3 py-3 text-sm" role="alert">
              {visitError}
            </div>
          ) : null}
          {accountClosed ? (
            <div className="rounded-2xl bg-amber-500/15 px-3 py-3 text-sm" role="status">
              La cuenta de esta mesa ya se cerró. Desde este celular no se puede seguir pidiendo. Si seguís en la mesa, escaneá el QR otra vez.
            </div>
          ) : null}
          {error ? (
            <div className="rounded-2xl bg-rose-500/15 px-3 py-3 text-sm" role="alert">
              {error}
            </div>
          ) : null}

          {visibleMenuItems.length > 0 ? (
            <div className="space-y-3">
              <label className="block">
                <span className="sr-only">{copy.search}</span>
                <input
                  type="search"
                  value={menuSearchQuery}
                  onChange={(e) => setMenuSearchQuery(e.target.value)}
                  placeholder={copy.search}
                  autoComplete="off"
                  className="h-11 w-full rounded-full bg-[var(--surface)] px-4 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
                />
              </label>
              {dietOptions.length ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label={copy.filters}>
                  {dietOptions.map((id) => {
                    const on = dietFilter === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setDietFilter(on ? "" : id)}
                        className={`h-11 rounded-full px-4 text-sm font-medium ${
                          on ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--surface)] text-[var(--muted)]"
                        }`}
                      >
                        {copy[id]}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {menuSearchQuery.trim() || dietFilter ? (
                <p className="text-xs text-[var(--muted)]">
                  {menuItemsFiltered.length} / {visibleMenuItems.length} {copy.products}
                </p>
              ) : null}
            </div>
          ) : null}

          {visibleMenuItems.length > 0 && menuItemsFiltered.length === 0 ? (
            <p className="rounded-2xl bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--muted)]">{copy.noMatch}</p>
          ) : null}
          {menuItems.length > 0 && visibleMenuItems.length === 0 ? (
            <p className="rounded-2xl bg-[var(--surface)] px-4 py-6 text-center text-sm text-[var(--muted)]">{copy.empty}</p>
          ) : null}

          {groupedMenu.map(([category, items]) => (
            <section key={category} id={categoryDomId(category)} className="carta-section space-y-3 pt-4">
              <div className="flex items-center gap-3">
                <h2 className="carta-serif text-2xl font-semibold">{displayDishName(category)}</h2>
                <span className="h-px flex-1 bg-gradient-to-r from-[var(--accent)]/70 to-transparent" aria-hidden="true" />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((item, index) => {
                  const qty = cartById[item.id] || 0;
                  const stock = readMenuStock(item);
                  return (
                    <DishCard
                      key={item.id}
                      item={item}
                      index={index}
                      qty={qty}
                      viewOnly={viewOnly}
                      canAdd={stock == null || qty < stock}
                      disabled={submitting || accountClosed}
                      onOpen={setSelectedId}
                      onAdd={addToCart}
                      onRemove={removeFromCart}
                      copy={copy}
                    />
                  );
                })}
              </div>
            </section>
          ))}

          {viewOnly ? null : (
            <label className="block pt-2">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
                {copy.note} <span className="normal-case tracking-normal">({copy.noteHint})</span>
              </span>
              <textarea
                value={observacion}
                onChange={(e) => setObservacion(e.target.value)}
                rows={2}
                maxLength={400}
                disabled={submitting}
                placeholder={copy.notePh}
                className="mt-2 w-full resize-y rounded-2xl bg-[var(--surface)] px-3 py-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
              />
            </label>
          )}
        </div>
        <CartaFooter
          name={headerName}
          address={place.address}
          openingHours={place.openingHours}
          whatsapp={place.whatsapp}
          copy={copy}
        />
      </main>

      {viewOnly ? null : (
        <div className="carta-orderbar fixed inset-x-0 bottom-0 z-20 bg-[var(--bg)]/95 px-4 py-3 backdrop-blur" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3">
            <div className="min-w-0">
              <p className="text-[11px] text-[var(--muted)]">{copy.inOrder}</p>
              <p className="text-lg font-semibold tabular-nums text-[var(--accent)]">{formatMenuPrice(totalAmount)}</p>
            </div>
            <button
              type="button"
              disabled={submitting || accountClosed || cartLines.length === 0 || !visit?.visitToken}
              onClick={() => submitOrder()}
              className="h-12 min-w-[44px] flex-1 rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-40"
            >
              {submitting ? copy.sending : copy.send}
            </button>
          </div>
        </div>
      )}

      <WhatsappFab whatsapp={place.whatsapp} copy={copy} lifted={!viewOnly} />
      </div>

      {selectedItem ? (
        <DishModal
          item={selectedItem}
          qty={cartById[selectedItem.id] || 0}
          viewOnly={viewOnly}
          canAdd={readMenuStock(selectedItem) == null || (cartById[selectedItem.id] || 0) < readMenuStock(selectedItem)}
          disabled={submitting || accountClosed}
          onAdd={addToCart}
          onRemove={removeFromCart}
          onClose={() => setSelectedId("")}
          copy={copy}
        />
      ) : null}

      {toast ? (
        <div
          className="pointer-events-none fixed left-1/2 z-[60] -translate-x-1/2 px-4"
          style={{ bottom: viewOnly ? "calc(env(safe-area-inset-bottom) + 5rem)" : "calc(env(safe-area-inset-bottom) + 6.5rem)" }}
          role="status"
          aria-live="polite"
        >
          <div className="rounded-full bg-[var(--surface)] px-4 py-2 text-center text-sm font-medium text-[var(--text)] shadow-[var(--shadow)]">
            {toast}
          </div>
        </div>
      ) : null}

      {confirmDialog ? <ConfirmModal dialog={confirmDialog} onResolve={handleConfirmDialog} /> : null}
    </CartaFrame>
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
      className="fixed inset-0 z-[70] flex items-center justify-center px-4"
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
