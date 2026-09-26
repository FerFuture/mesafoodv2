import qz from "qz-tray";
import {
  groupOrderItemRows,
  orderObservacionText,
  tableNumberLabel,
  waiterNameFromMozoNotes
} from "./format";

let connectPromise = null;

function allowUnsignedQz() {
  qz.security.setCertificatePromise((resolve) => {
    resolve();
  });
  qz.security.setSignaturePromise(() => (resolve) => {
    resolve();
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
  allowUnsignedQz();
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
  const found = await qz.printers.find();
  if (Array.isArray(found)) return found.filter(Boolean);
  return found ? [found] : [];
}

function lineWidth(widthMm) {
  return Number(widthMm) <= 58 ? 32 : 48;
}

function clip(text, width) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}

function ticketText(order, restaurantName, widthMm) {
  const width = lineWidth(widthMm);
  const rule = "-".repeat(width);
  const mesa = tableNumberLabel(order);
  const rows = groupOrderItemRows(order);
  const observacion = orderObservacionText(order);
  const mozo = waiterNameFromMozoNotes(order?.notes);
  const when = order?.created_at ? new Date(order.created_at).toLocaleString("es-AR") : "";
  const title = mesa ? `MESA ${mesa}` : "PEDIDO";
  const lines = [
    clip(restaurantName || "Cocina", width),
    when,
    rule,
    title,
    `#${String(order?.id || "").slice(0, 8)}`,
    rule
  ];
  if (!rows.length) lines.push("(sin items)");
  for (const row of rows) {
    const qty = row.count > 1 ? `${row.count} x ` : "1 x ";
    lines.push(clip(`${qty}${row.name}`, width));
  }
  if (observacion) {
    lines.push(rule, clip(`OBS: ${observacion}`, width));
  }
  if (mozo) lines.push(clip(`Mozo: ${mozo}`, width));
  return lines.join("\n");
}

export async function printKitchenTicket({ printer, widthMm, restaurantName, order }) {
  const name = String(printer || "").trim();
  if (!name) {
    const error = new Error("Elegí la impresora de la cocina.");
    error.code = "no_printer";
    throw error;
  }
  await connectKitchenPrinter();
  const config = qz.configs.create(name, { encoding: "Cp1252" });
  const body = ticketText(order, restaurantName, widthMm);
  const data = `\x1B@\x1Ba\x00${body}\n\n\n\x1DV\x42\x00`;
  await qz.print(config, [{ type: "raw", format: "plain", data }]);
}
