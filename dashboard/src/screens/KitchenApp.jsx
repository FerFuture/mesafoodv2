import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { fetchRestaurantForDashboard } from "../lib/restaurantTenant";
import {
  formatDateTime,
  groupOrderItemRows,
  isDeliveryOrder,
  isWaiterDeliveryOrder,
  kitchenMetaBoxContent,
  normalizeOrderStatus,
  orderInKitchenQueue,
  orderPlacedByWaiter,
  orderObservacionText,
  playNotification,
  tableNumberLabel
} from "../lib/format";
import { listKitchenPrinters, printKitchenTicket } from "../lib/kitchenPrinter";

const HISTORY_HOURS = 18;

function printerStorageKey(restaurantId, field) {
  return `mesafood-kitchen-${field}:${restaurantId}`;
}

export default function KitchenApp({ onLogout }) {
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [printers, setPrinters] = useState([]);
  const [printerName, setPrinterName] = useState("");
  const [paperWidth, setPaperWidth] = useState("80");
  const [printerStatus, setPrinterStatus] = useState("Conectando con QZ Tray…");
  const [printingId, setPrintingId] = useState("");
  const printedIdsRef = useRef(new Set());
  const printerNameRef = useRef("");
  const paperWidthRef = useRef("80");
  const restaurantNameRef = useRef("");

  useEffect(() => {
    async function loadRestaurant() {
      const { data, error: queryError } = await fetchRestaurantForDashboard(supabase);
      if (queryError) {
        setError(`Error resolviendo restaurante: ${queryError.message}`);
        return;
      }
      if (!data) {
        setError("No se encontró el restaurante asociado a este panel.");
        return;
      }
      setRestaurantId(data.id);
      setRestaurantName(data.name || "");
      restaurantNameRef.current = data.name || "";
      const savedPrinter = localStorage.getItem(printerStorageKey(data.id, "printer")) || "";
      const savedWidth = localStorage.getItem(printerStorageKey(data.id, "width")) || "80";
      setPrinterName(savedPrinter);
      setPaperWidth(savedWidth === "58" ? "58" : "80");
      printerNameRef.current = savedPrinter;
      paperWidthRef.current = savedWidth === "58" ? "58" : "80";
    }
    loadRestaurant();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function connectPrinter() {
      try {
        const found = await listKitchenPrinters();
        if (cancelled) return;
        setPrinters(found);
        setPrinterName((current) => {
          const next = current && found.includes(current) ? current : found[0] || "";
          printerNameRef.current = next;
          if (restaurantId && next) {
            localStorage.setItem(printerStorageKey(restaurantId, "printer"), next);
          }
          return next;
        });
        setPrinterStatus(found.length ? "QZ Tray conectado" : "QZ Tray conectado, sin impresoras");
      } catch (connectError) {
        if (cancelled) return;
        setPrinterStatus("QZ Tray no está abierto en esta computadora");
        setError("");
        console.warn(connectError);
      }
    }
    connectPrinter();
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  useEffect(() => {
    if (!restaurantId) return undefined;
    let active = true;

    async function loadOrders() {
      setLoading(true);
      const sinceIso = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();
      const { data, error: queryError } = await supabase
        .from("orders")
        .select("*")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .limit(300);
      if (!active) return;
      if (queryError) {
        setError(`Error cargando pedidos: ${queryError.message}`);
        setLoading(false);
        return;
      }
      for (const order of data || []) printedIdsRef.current.add(order.id);
      setOrders(data || []);
      setLoading(false);
    }

    loadOrders();

    const channel = supabase
      .channel(`kitchen-orders-${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new;
            setOrders((prev) => {
              if (prev.some((o) => o.id === row.id)) return prev;
              const next = [...prev, row].sort(
                (a, b) => new Date(a.created_at) - new Date(b.created_at)
              );
              if (orderInKitchenQueue(row)) {
                playNotification();
                void sendTicket(row);
              }
              return next;
            });
            return;
          }
          if (payload.eventType === "UPDATE") {
            const row = payload.new;
            setOrders((prev) => {
              const oldRow = prev.find((o) => o.id === row.id);
              const merged = prev.map((o) => (o.id === row.id ? row : o));
              const next = oldRow
                ? merged
                : [...prev, row].sort(
                    (a, b) => new Date(a.created_at) - new Date(b.created_at)
                  );
              if (orderInKitchenQueue(row) && (!oldRow || !orderInKitchenQueue(oldRow))) {
                playNotification();
                void sendTicket(row);
              }
              return next;
            });
          }
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [restaurantId]);

  async function sendTicket(order) {
    if (!order?.id || printedIdsRef.current.has(order.id)) return;
    if (!printerNameRef.current) {
      setPrinterStatus("Elegí la impresora para que salgan los tickets");
      return;
    }
    printedIdsRef.current.add(order.id);
    setPrintingId(order.id);
    try {
      await printKitchenTicket({
        printer: printerNameRef.current,
        widthMm: paperWidthRef.current,
        restaurantName: restaurantNameRef.current,
        order
      });
      setPrinterStatus("Ticket enviado a la comanda");
    } catch (printError) {
      printedIdsRef.current.delete(order.id);
      setError(`No se pudo imprimir: ${printError?.message || printError}`);
    } finally {
      setPrintingId("");
    }
  }

  const queue = useMemo(
    () => orders.filter((o) => orderInKitchenQueue(o)).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    ),
    [orders]
  );

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-white">Cocina</h1>
            <p className="text-xs text-slate-400">{restaurantName || "…"}</p>
            <p className="text-xs text-slate-500">{printerStatus}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-400">
              Impresora
              <select
                value={printerName}
                onChange={(event) => {
                  const next = event.target.value;
                  setPrinterName(next);
                  printerNameRef.current = next;
                  if (restaurantId) {
                    localStorage.setItem(printerStorageKey(restaurantId, "printer"), next);
                  }
                }}
                className="ml-2 h-9 rounded-lg border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100"
              >
                <option value="">Elegir</option>
                {printers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Papel
              <select
                value={paperWidth}
                onChange={(event) => {
                  const next = event.target.value === "58" ? "58" : "80";
                  setPaperWidth(next);
                  paperWidthRef.current = next;
                  if (restaurantId) {
                    localStorage.setItem(printerStorageKey(restaurantId, "width"), next);
                  }
                }}
                className="ml-2 h-9 rounded-lg border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100"
              >
                <option value="80">80 mm</option>
                <option value="58">58 mm</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                void sendTicket({
                  id: `prueba-${Date.now()}`,
                  created_at: new Date().toISOString(),
                  items: [{ name: "Ticket de prueba" }],
                  notes: "Mesa: 1",
                  observacion: "Si leés esto, la comanda imprime."
                });
              }}
              className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/10"
            >
              Probar
            </button>
            <button
              type="button"
              onClick={() => onLogout?.()}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {error ? (
          <div className="mb-4 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {loading ? (
          <p className="text-slate-400">Cargando pedidos…</p>
        ) : queue.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-6 py-12 text-center text-slate-400">
            No hay pedidos confirmados para elaborar en este momento.
          </div>
        ) : (
          <ul className="space-y-4">
            {queue.map((order) => {
              const rows = groupOrderItemRows(order);
              const mesa = tableNumberLabel(order);
              const st = normalizeOrderStatus(order);
              const fromCustomer = !orderPlacedByWaiter(order);
              const waiterDelivery = isWaiterDeliveryOrder(order);
              const kitchenMeta = kitchenMetaBoxContent(order);
              const observacion = orderObservacionText(order);
              return (
                <li
                  key={order.id}
                  className="rounded-xl border border-amber-500/25 bg-slate-900/80 p-4 shadow-lg shadow-black/20"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs text-slate-500">
                        #{String(order.id).slice(0, 8)} · {formatDateTime(order.created_at)}
                      </p>
                      <p className="mt-1 text-sm text-slate-300">
                        {fromCustomer ? (
                          isDeliveryOrder(order) ? (
                            <span className="font-medium text-sky-300">Delivery</span>
                          ) : (
                            <span className="font-medium text-violet-300">Retiro en local</span>
                          )
                        ) : (
                          <>
                            {waiterDelivery ? (
                              <span className="text-sky-300">Delivery mozo</span>
                            ) : isDeliveryOrder(order) ? (
                              <span className="text-sky-300">Delivery</span>
                            ) : (
                              <span className="text-violet-300">Local / retiro</span>
                            )}
                            {mesa ? (
                              <span className="ml-2 rounded-full bg-violet-500/25 px-2 py-0.5 text-xs font-semibold text-violet-200">
                                Mesa {mesa}
                              </span>
                            ) : null}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={printingId === order.id}
                        onClick={() => {
                          printedIdsRef.current.delete(order.id);
                          void sendTicket(order);
                        }}
                        className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                      >
                        {printingId === order.id ? "Imprimiendo…" : "Imprimir"}
                      </button>
                      <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs text-blue-200">
                        {st}
                      </span>
                    </div>
                  </div>

                  <ul className="mt-3 space-y-1 text-sm text-slate-100">
                    {rows.map((r) => (
                      <li key={`${order.id}-${r.name}`}>
                        <span className="font-medium text-emerald-200/90">{r.name}</span>
                        {r.count > 1 ? (
                          <span className="text-slate-400"> ×{r.count}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  {observacion ? (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-amber-500/40 bg-amber-950/40 px-2 py-1.5 text-sm font-medium text-amber-100">
                      Observación: {observacion}
                    </p>
                  ) : null}

                  {kitchenMeta ? (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-slate-700/80 bg-slate-950/50 px-2 py-1.5 text-xs text-slate-300">
                      {kitchenMeta}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
