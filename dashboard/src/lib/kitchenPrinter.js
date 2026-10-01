import qz from "qz-tray";
import {
  currency,
  encargoCustomerName,
  groupOrderItemRows,
  isEncargoOrder,
  orderObservacionText,
  tableNumberLabel,
  waiterNameFromMozoNotes
} from "./format";
import { QZ_CERTIFICATE } from "./qzCertificate";

let connectPromise = null;

function trustKitchenQz() {
  qz.security.setCertificatePromise((resolve) => {
    resolve(QZ_CERTIFICATE);
  });
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
    fetch("/api/qz/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: toSign }),
      cache: "no-store"
    })
      .then(async (response) => {
        const text = (await response.text()).trim();
        if (!response.ok || !text) reject(text || "No se pudo firmar la impresión");
        else resolve(text);
      })
      .catch(reject);
  });
}

export function qzIsConnected() {
  try {
    return qz.websocket.isActive();
  } catch {
    return false;
  }
}

export async function connectKitchenPrinter() {
  trustKitchenQz();
  if (qzIsConnected()) return;
  if (!connectPromise) {
    connectPromise = qz.websocket.connect().finally(() => {
      connectPromise = null;
    });
  }
  await connectPromise;
}

export async function listKitchenPrinters() {
  await connectKitchenPrinter();
  try {
    const raw = await qz.printers.details();
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const printers = list
      .map((printer) => ({
        name: String(printer?.name || "").trim(),
        connection: String(printer?.connection || "").trim(),
        driver: String(printer?.driver || "").trim(),
        isDefault: Boolean(printer?.default)
      }))
      .filter((printer) => printer.name);
    if (printers.length) return printers;
  } catch (detailsError) {
    console.warn(detailsError);
  }
  const found = await qz.printers.find();
  const names = Array.isArray(found) ? found : found ? [found] : [];
  return names.filter(Boolean).map((name) => ({
    name: String(name),
    connection: "",
    driver: "",
    isDefault: false
  }));
}

let printQueue = Promise.resolve();

function enqueuePrint(task) {
  const run = printQueue.then(task, task);
  printQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function exactPrinterName(requested) {
  const wanted = String(requested || "").trim();
  if (!wanted) {
    const error = new Error("Elegí la impresora.");
    error.code = "no_printer";
    throw error;
  }
  await connectKitchenPrinter();
  const found = await qz.printers.find();
  const names = (Array.isArray(found) ? found : found ? [found] : []).filter(Boolean).map(String);
  const exact =
    names.find((name) => name === wanted) ||
    names.find((name) => name.trim().toLowerCase() === wanted.toLowerCase());
  if (!exact) {
    const error = new Error(`No está la impresora "${wanted}". Elegila de nuevo.`);
    error.code = "printer_missing";
    throw error;
  }
  return exact;
}

function textBytes(value) {
  const bytes = [];
  for (const char of String(value || "")) {
    const code = char.codePointAt(0);
    bytes.push(code <= 0xff ? code : 0x3f);
  }
  return bytes;
}

function wrapText(value, cols) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  if (text.length <= cols) return [text];
  const lines = [];
  let rest = text;
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(" ", cols);
    if (cut < 1) cut = cols;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

function bytesToHex(bytes) {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function paperCols(widthMm) {
  return Number(widthMm) <= 58 ? 32 : 42;
}

function escPosTicket(lines, cols) {
  const bytes = [
    0x1b, 0x40,
    0x1b, 0x74, 0x10,
    0x1b, 0x61, 0x01,
    0x1b, 0x45, 0x01
  ];
  const title = lines.title || "";
  bytes.push(0x1d, 0x21, 0x11, ...textBytes(title), 0x0a, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00);
  for (const row of lines.center || []) {
    bytes.push(...textBytes(row), 0x0a);
  }
  bytes.push(...textBytes("-".repeat(cols)), 0x0a, 0x1b, 0x61, 0x00, 0x1b, 0x45, 0x01);
  for (const row of lines.items || []) {
    for (const wrapped of wrapText(row, cols)) bytes.push(...textBytes(wrapped), 0x0a);
  }
  bytes.push(0x1b, 0x45, 0x00, ...textBytes("-".repeat(cols)), 0x0a);
  for (const row of lines.footer || []) {
    for (const wrapped of wrapText(row, cols)) bytes.push(...textBytes(wrapped), 0x0a);
  }
  bytes.push(0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00);
  return bytesToHex(bytes);
}

async function sendEscPos(printer, hex, jobName) {
  return enqueuePrint(async () => {
    const name = await exactPrinterName(printer);
    const config = qz.configs.create(name, { jobName });
    await qz.print(config, [
      {
        type: "raw",
        format: "command",
        flavor: "hex",
        data: hex
      }
    ]);
    return name;
  });
}

export async function printKitchenTicket({ printer, widthMm, restaurantName, order }) {
  const name = String(printer || "").trim();
  if (!name) {
    const error = new Error("Elegí la impresora de la cocina.");
    error.code = "no_printer";
    throw error;
  }
  const cols = paperCols(widthMm);
  const mesa = tableNumberLabel(order);
  const encargo = isEncargoOrder(order);
  const rows = groupOrderItemRows(order);
  const observacion = orderObservacionText(order);
  const mozo = waiterNameFromMozoNotes(order?.notes);
  const cliente = encargo ? encargoCustomerName(order) : "";
  const when = encargo && order?.scheduled_delivery_at
    ? `Para ${new Date(order.scheduled_delivery_at).toLocaleString("es-AR")}`
    : order?.created_at
      ? new Date(order.created_at).toLocaleString("es-AR")
      : "";
  const items = rows.length
    ? rows.map((row) => `${row.count > 1 ? row.count : 1} x ${row.name}`)
    : ["(sin items)"];
  const footer = [
    cliente ? `Cliente: ${cliente}` : "",
    observacion ? `OBS: ${observacion}` : "",
    mozo ? `Mozo: ${mozo}` : ""
  ].filter(Boolean);
  const hex = escPosTicket(
    {
      title: encargo ? "ENCARGO" : mesa ? `MESA ${mesa}` : "PEDIDO",
      center: [restaurantName || "Cocina", when].filter(Boolean),
      items,
      footer
    },
    cols
  );
  return sendEscPos(name, hex, "MesaFood comanda");
}

function billItemRows(orders) {
  const rows = new Map();
  const sequence = [];
  for (const order of orders || []) {
    const items = Array.isArray(order?.items) ? order.items : [];
    for (const item of items) {
      const name = typeof item === "string" ? item.trim() : String(item?.name || item?.title || "").trim();
      if (!name) continue;
      const price = item && typeof item === "object" ? Number(item.price) : NaN;
      if (!rows.has(name)) {
        rows.set(name, { name, count: 0, total: 0 });
        sequence.push(name);
      }
      const row = rows.get(name);
      row.count += 1;
      if (Number.isFinite(price)) row.total += price;
    }
  }
  return sequence.map((name) => rows.get(name));
}

export async function printCustomerBill({ printer, widthMm, restaurantName, orders, tableNumber }) {
  const name = String(printer || "").trim();
  if (!name) {
    const error = new Error("Elegí la impresora de cuentas.");
    error.code = "no_printer";
    throw error;
  }
  const cols = paperCols(widthMm);
  const rows = billItemRows(orders);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const notes = (orders || []).map((order) => orderObservacionText(order)).filter(Boolean);
  const mozos = [
    ...new Set((orders || []).map((order) => waiterNameFromMozoNotes(order?.notes)).filter(Boolean))
  ];
  const mesa = tableNumber || tableNumberLabel(orders?.[0]);
  const items = rows.length
    ? rows.map((row) => {
        const qty = row.count > 1 ? `${row.count} x ` : "1 x ";
        const price = row.total > 0 ? `  ${currency(row.total)}` : "";
        return `${qty}${row.name}${price}`;
      })
    : ["(sin items)"];
  const footer = [
    ...notes.map((note) => `OBS: ${note}`),
    `TOTAL ${currency(total)}`,
    mozos.length ? `Mozo: ${mozos.join(", ")}` : "",
    "Gracias"
  ].filter(Boolean);
  const hex = escPosTicket(
    {
      title: mesa ? `CUENTA MESA ${mesa}` : "CUENTA",
      center: [restaurantName || "", new Date().toLocaleString("es-AR")].filter(Boolean),
      items,
      footer
    },
    cols
  );
  return sendEscPos(name, hex, "MesaFood cuenta");
}
