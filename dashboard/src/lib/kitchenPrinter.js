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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ticketHtml(order, restaurantName, widthMm) {
  const mesa = tableNumberLabel(order);
  const rows = groupOrderItemRows(order);
  const observacion = orderObservacionText(order);
  const mozo = waiterNameFromMozoNotes(order?.notes);
  const when = order?.created_at ? new Date(order.created_at).toLocaleString("es-AR") : "";
  const title = mesa ? `MESA ${mesa}` : "PEDIDO";
  const items = rows.length
    ? rows
        .map((row) => {
          const qty = row.count > 1 ? `${row.count} x ` : "1 x ";
          return `<div class="item">${escapeHtml(`${qty}${row.name}`)}</div>`;
        })
        .join("")
    : `<div class="item">(sin items)</div>`;
  const extra = [
    observacion ? `<div class="obs">OBS: ${escapeHtml(observacion)}</div>` : "",
    mozo ? `<div class="meta">Mozo: ${escapeHtml(mozo)}</div>` : ""
  ].join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; width: ${Number(widthMm) <= 58 ? 48 : 72}mm; }
    body { font-family: Arial, sans-serif; color: #000; }
    h1 { font-size: 18px; text-align: center; margin: 0 0 4px; }
    .meta { text-align: center; font-size: 11px; margin: 0; }
    .rule { border-top: 1px dashed #000; margin: 6px 0; }
    .item { font-size: 16px; font-weight: 700; margin: 3px 0; }
    .obs { font-size: 14px; font-weight: 700; margin-top: 6px; }
  </style></head><body>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">${escapeHtml(restaurantName || "Cocina")}</p>
    <p class="meta">${escapeHtml(when)}</p>
    <div class="rule"></div>
    ${items}
    <div class="rule"></div>
    ${extra}
  </body></html>`;
}

export async function printKitchenTicket({ printer, widthMm, restaurantName, order }) {
  const name = String(printer || "").trim();
  if (!name) {
    const error = new Error("Elegí la impresora de la cocina.");
    error.code = "no_printer";
    throw error;
  }
  await connectKitchenPrinter();
  const mm = Number(widthMm) <= 58 ? 58 : 80;
  const rows = groupOrderItemRows(order);
  const height = Math.min(280, 70 + rows.length * 10);
  const config = qz.configs.create(name, {
    units: "mm",
    size: { width: mm, height },
    margins: 0,
    colorType: "blackwhite",
    scaleContent: true,
    interpolation: "nearest-neighbor"
  });
  await qz.print(config, [
    {
      type: "pixel",
      format: "html",
      flavor: "plain",
      data: ticketHtml(order, restaurantName, mm)
    }
  ]);
}
