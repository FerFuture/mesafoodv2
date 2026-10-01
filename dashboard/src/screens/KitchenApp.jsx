import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient";
import { fetchRestaurantForDashboard } from "../lib/restaurantTenant";
import {
  ENCARGO_KITCHEN_LEAD_MS,
  encargoCustomerName,
  encargoDueAt,
  encargoVisibleInKitchen,
  formatDateTime,
  groupOrderItemRows,
  isDeliveryOrder,
  isEncargoOrder,
  isWaiterDeliveryOrder,
  kitchenMetaBoxContent,
  normalizeOrderStatus,
  orderInKitchenQueue,
  orderPlacedByWaiter,
  orderObservacionText,
  playNotification,
  tableNumberLabel
} from "../lib/format";
import { listKitchenPrinters, printCustomerBill, printKitchenTicket } from "../lib/kitchenPrinter";

const HISTORY_HOURS = 18;

function printerStorageKey(restaurantId, field) {
  return `mesafood-kitchen-${field}:${restaurantId}`;
}

const RECENT_TICKET_MS = 15 * 60 * 1000;

function readPrintedIds(restaurantId, field = "printed") {
  try {
    const raw = JSON.parse(localStorage.getItem(printerStorageKey(restaurantId, field)) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function rememberPrintedId(restaurantId, orderId, field = "printed") {
  const ids = [...readPrintedIds(restaurantId, field), orderId].slice(-200);
  localStorage.setItem(printerStorageKey(restaurantId, field), JSON.stringify(ids));
}

function matchListedPrinter(saved, printers) {
  const wanted = String(saved || "").trim().toLowerCase();
  if (!wanted) return "";
  const hit = printers.find((printer) => printer.name.trim().toLowerCase() === wanted);
  return hit?.name || "";
}

export default function KitchenApp({ onLogout }) {
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [printers, setPrinters] = useState([]);
  const [printerName, setPrinterName] = useState("");
  const [billPrinterName, setBillPrinterName] = useState("");
  const [paperWidth, setPaperWidth] = useState("80");
  const [printerStatus, setPrinterStatus] = useState("Conectando con QZ Tray…");
  const [printingId, setPrintingId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const printedIdsRef = useRef(new Set());
  const listeningRef = useRef(false);
  const printerNameRef = useRef("");
  const billPrinterRef = useRef("");
  const paperWidthRef = useRef("80");
  const restaurantNameRef = useRef("");
  const ordersRef = useRef([]);
  const billPrintedRef = useRef(new Set());
  const billListeningRef = useRef(false);

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
      const savedBillPrinter = localStorage.getItem(printerStorageKey(data.id, "bill-printer")) || "";
      const savedWidth = localStorage.getItem(printerStorageKey(data.id, "width")) || "80";
      setPrinterName(savedPrinter);
      setBillPrinterName(savedBillPrinter);
      setPaperWidth(savedWidth === "58" ? "58" : "80");
      printerNameRef.current = savedPrinter;
      billPrinterRef.current = savedBillPrinter;
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
          const saved = current || printerNameRef.current;
          const matched = matchListedPrinter(saved, found);
          const next = matched || (!saved ? found[0]?.name || "" : current);
          if (next) {
            printerNameRef.current = next;
            if (restaurantId) {
              localStorage.setItem(printerStorageKey(restaurantId, "printer"), next);
            }
          }
          return next;
        });
        setBillPrinterName((current) => {
          const saved = current || billPrinterRef.current;
          const matched = matchListedPrinter(saved, found);
          if (!matched) return current;
          billPrinterRef.current = matched;
          if (restaurantId) {
            localStorage.setItem(printerStorageKey(restaurantId, "bill-printer"), matched);
          }
          return matched;
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
      const recentQuery = supabase
        .from("orders")
        .select("*")
        .eq("restaurant_id", restaurantId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .limit(300);
      const { data, error: queryError } = await recentQuery;
      if (!active) return;
      if (queryError) {
        setError(`Error cargando pedidos: ${queryError.message}`);
        setLoading(false);
        return;
      }
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
              if (orderInKitchenQueue(row)) playNotification();
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
      const used = await printKitchenTicket({
        printer: printerNameRef.current,
        widthMm: paperWidthRef.current,
        restaurantName: restaurantNameRef.current,
        order
      });
      if (restaurantId) rememberPrintedId(restaurantId, order.id);
      setPrinterStatus(`Comanda enviada a ${used}`);
    } catch (printError) {
      printedIdsRef.current.delete(order.id);
      setError(`No se pudo imprimir: ${printError?.message || printError}`);
    } finally {
      setPrintingId("");
    }
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  function kitchenSortTime(order) {
    if (isEncargoOrder(order)) {
      const due = encargoDueAt(order);
      if (due != null) return due - ENCARGO_KITCHEN_LEAD_MS;
    }
    return new Date(order.created_at).getTime();
  }

  const queue = useMemo(
    () => orders.filter((o) => orderInKitchenQueue(o, now)).sort(
      (a, b) => kitchenSortTime(b) - kitchenSortTime(a)
    ),
    [orders, now]
  );
  const programados = useMemo(
    () => orders
      .filter((order) => {
        if (!isEncargoOrder(order)) return false;
        const status = normalizeOrderStatus(order);
        if (status === "delivered" || status === "cancelled") return false;
        if (status !== "confirmed") return false;
        if (encargoDueAt(order) == null) return false;
        return !encargoVisibleInKitchen(order, now);
      })
      .sort((a, b) => (encargoDueAt(a) || 0) - (encargoDueAt(b) || 0)),
    [orders, now]
  );
  const samePortWarning = useMemo(() => {
    if (!printerName || !billPrinterName || printerName === billPrinterName) return "";
    const comanda = printers.find((printer) => printer.name === printerName);
    const cuenta = printers.find((printer) => printer.name === billPrinterName);
    const portA = comanda?.connection || "";
    const portB = cuenta?.connection || "";
    if (!portA || portA !== portB) return "";
    return `Comanda y cuentas están las dos en el puerto ${portA}. Windows manda los dos tickets a la misma máquina. Conectá la segunda impresora en otro USB para que quede en otro puerto y volvé a elegirla.`;
  }, [billPrinterName, printerName, printers]);
  ordersRef.current = orders;

  useEffect(() => {
    if (!restaurantId) return undefined;
    let cancelled = false;

    async function printBill(job) {
      if (!job?.id || billPrintedRef.current.has(job.id)) return;
      const already = readPrintedIds(restaurantId, "bills");
      if (already.has(job.id)) {
        billPrintedRef.current.add(job.id);
        return;
      }
      const age = Date.now() - new Date(job.at).getTime();
      const recent = Number.isFinite(age) && age >= -5000 && age < RECENT_TICKET_MS;
      if (!billListeningRef.current && !recent) {
        rememberPrintedId(restaurantId, job.id, "bills");
        billPrintedRef.current.add(job.id);
        return;
      }
      if (!billPrinterRef.current) {
        setPrinterStatus("Elegí la impresora de cuentas");
        return;
      }
      const ids = Array.isArray(job.orderIds) ? job.orderIds : [];
      let rows = ordersRef.current.filter((order) => ids.includes(order.id));
      if (rows.length < ids.length) {
        const { data } = await supabase.from("orders").select("*").in("id", ids);
        if (cancelled) return;
        rows = data || rows;
      }
      billPrintedRef.current.add(job.id);
      try {
        const used = await printCustomerBill({
          printer: billPrinterRef.current,
          widthMm: paperWidthRef.current,
          restaurantName: restaurantNameRef.current,
          orders: rows,
          tableNumber: job.tableNumber
        });
        rememberPrintedId(restaurantId, job.id, "bills");
        setPrinterStatus(`Cuenta enviada a ${used}`);
      } catch (printError) {
        billPrintedRef.current.delete(job.id);
        setError(`No se pudo imprimir la cuenta: ${printError?.message || printError}`);
      }
    }

    async function pullBills() {
      const { data } = await supabase
        .from("restaurants")
        .select("metadata")
        .eq("id", restaurantId)
        .maybeSingle();
      if (cancelled) return;
      const jobs = Array.isArray(data?.metadata?.bill_print_jobs) ? data.metadata.bill_print_jobs : [];
      for (const job of jobs) {
        await printBill(job);
      }
      billListeningRef.current = true;
    }

    pullBills();
    const timer = setInterval(pullBills, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [restaurantId, billPrinterName]);

  useEffect(() => {
    if (loading || !restaurantId || !printerName) return;
    const alreadyPrinted = readPrintedIds(restaurantId);
    for (const order of queue) {
      if (printedIdsRef.current.has(order.id) || alreadyPrinted.has(order.id)) continue;
      const due = isEncargoOrder(order) ? encargoDueAt(order) : null;
      const age = due != null
        ? Date.now() - (due - ENCARGO_KITCHEN_LEAD_MS)
        : Date.now() - new Date(order.created_at).getTime();
      const recent = Number.isFinite(age) && age >= -5000 && age < RECENT_TICKET_MS;
      if (!listeningRef.current && !recent) {
        rememberPrintedId(restaurantId, order.id);
        printedIdsRef.current.add(order.id);
        continue;
      }
      void sendTicket(order);
    }
    listeningRef.current = true;
  }, [queue, loading, restaurantId, printerName]);

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
              Comanda
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
                {printers.map((printer) => (
                  <option key={printer.name} value={printer.name}>
                    {printer.connection ? `${printer.name} · ${printer.connection}` : printer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Cuentas
              <select
                value={billPrinterName}
                onChange={(event) => {
                  const next = event.target.value;
                  setBillPrinterName(next);
                  billPrinterRef.current = next;
                  if (restaurantId) {
                    localStorage.setItem(printerStorageKey(restaurantId, "bill-printer"), next);
                  }
                }}
                className="ml-2 h-9 rounded-lg border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100"
              >
                <option value="">Elegir</option>
                {printers.map((printer) => (
                  <option key={`bill-${printer.name}`} value={printer.name}>
                    {printer.connection ? `${printer.name} · ${printer.connection}` : printer.name}
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
              Probar comanda
            </button>
            <button
              type="button"
              onClick={() => {
                if (!billPrinterRef.current) {
                  setPrinterStatus("Elegí la impresora de cuentas");
                  return;
                }
                void printCustomerBill({
                  printer: billPrinterRef.current,
                  widthMm: paperWidthRef.current,
                  restaurantName: restaurantNameRef.current,
                  orders: [
                    {
                      items: [{ name: "Prueba de cuenta", price: 100 }],
                      notes: "Mesa: 1"
                    }
                  ],
                  tableNumber: "1"
                })
                  .then((used) => setPrinterStatus(`Cuenta de prueba enviada a ${used}`))
                  .catch((printError) => {
                    setError(`No se pudo imprimir la cuenta: ${printError?.message || printError}`);
                  });
              }}
              className="rounded-lg border border-sky-500/40 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-500/10"
            >
              Probar cuenta
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
        {samePortWarning ? (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            {samePortWarning}
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {programados.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-amber-200">Programados</h2>
            <ul className="space-y-2">
              {programados.map((order) => {
                const name = encargoCustomerName(order);
                const rows = groupOrderItemRows(order);
                return (
                  <li key={order.id} className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3">
                    <p className="text-sm font-semibold text-amber-100">
                      Encargo{name ? ` · ${name}` : ""} · {formatDateTime(encargoDueAt(order) ? new Date(encargoDueAt(order)).toISOString() : order.scheduled_delivery_at)}
                    </p>
                    <p className="mt-1 text-sm text-slate-300">
                      {rows.map((row) => `${row.count} x ${row.name}`).join(" · ")}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">La comanda se imprime 10 minutos antes.</p>
                  </li>
                );
              })}
            </ul>
          </section>
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
              const encargo = isEncargoOrder(order);
              const encargoName = encargoCustomerName(order);
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
                        ) : encargo ? (
                          <span className="font-semibold text-amber-200">
                            Encargo{encargoName ? ` · ${encargoName}` : ""}
                            {encargoDueAt(order) || order.scheduled_delivery_at
                              ? ` · ${formatDateTime(encargoDueAt(order) ? new Date(encargoDueAt(order)).toISOString() : order.scheduled_delivery_at)}`
                              : ""}
                          </span>
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
