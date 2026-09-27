import qz from "qz-tray";
import {
  groupOrderItemRows,
  isDeliveryOrder,
  isWaiterDeliveryOrder,
  orderIsTableService,
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

function ticketHeading(order) {
  const mesa = tableNumberLabel(order);
  if (mesa && (orderIsTableService(order) || /mesa/i.test(String(order?.notes || "")))) {
    return `MESA ${mesa}`;
  }
  if (isDeliveryOrder(order) || isWaiterDeliveryOrder(order)) return "DELIVERY";
  const ft = String(order?.fulfillment_type || "").trim().toLowerCase();
  if (ft === "local") return "PARA LLEVAR";
  if (mesa) return `MESA ${mesa}`;
  return "PEDIDO";
}

function ticketOrigin(order) {
  const notes = String(order?.notes || "").trim();
  if (/·\s*Mozo:/i.test(notes) || /^Mozo\s*·/i.test(notes)) return "MOZO";
  if (/^Mesa:\s*\d+/i.test(notes)) return "QR";
  return "";
}

function ticketClock(order) {
  const date = order?.created_at ? new Date(order.created_at) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function ticketHtml(order, restaurantName, widthMm) {
  const rows = groupOrderItemRows(order);
  const observacion = orderObservacionText(order);
  const mozo = waiterNameFromMozoNotes(order?.notes);
  const origin = ticketOrigin(order);
  const clock = ticketClock(order);
  const shortId = String(order?.id || "").replace(/-/g, "").slice(-4).toUpperCase();
  const paper = Number(widthMm) <= 58 ? 48 : 72;
  const items = rows.length
    ? rows
        .map((row) => {
          const name = String(row.name || "").toLocaleUpperCase("es-AR");
          return `<div class="row"><span class="qty">${row.count}</span><span class="name">${escapeHtml(name)}</span></div>`;
        })
        .join("")
    : `<div class="row"><span class="name">(sin items)</span></div>`;
  const bits = [origin, shortId ? `#${shortId}` : "", mozo ? `Mozo ${mozo}` : ""].filter(Boolean);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    * { margin: 0; padding: 0; }
    html, body { width: ${paper}mm; background: #fff; color: #000; }
    body { font-family: Arial, sans-serif; margin-top: -7mm; }
    .mesa { font-size: 28px; font-weight: 900; text-align: center; line-height: 1; }
    .sub { text-align: center; font-size: 12px; font-weight: 700; margin-top: 2px; }
    .rule { border-top: 2px solid #000; margin: 5px 0 4px; }
    .row { margin: 3px 0; }
    .qty { display: inline-block; width: 1.4em; font-size: 22px; font-weight: 900; vertical-align: top; }
    .name { display: inline-block; width: calc(100% - 1.6em); font-size: 16px; font-weight: 700; }
    .obs { margin-top: 4px; border: 2px solid #000; padding: 3px 4px; text-align: center; font-size: 15px; font-weight: 900; }
    .foot { margin-top: 4px; text-align: center; font-size: 11px; }
  </style></head><body>
    <div class="mesa">${escapeHtml(ticketHeading(order))}</div>
    <div class="sub">${escapeHtml(restaurantName || "Cocina")}${clock ? ` · ${escapeHtml(clock)}` : ""}</div>
    <div class="rule"></div>
    ${items}
    ${observacion ? `<div class="obs">${escapeHtml(observacion.toLocaleUpperCase("es-AR"))}</div>` : ""}
    <div class="foot">${escapeHtml(`${rows.reduce((sum, row) => sum + row.count, 0)} items`)}${bits.length ? ` · ${escapeHtml(bits.join(" · "))}` : ""}</div>
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
  const extra = orderObservacionText(order) ? 12 : 0;
  const height = Math.min(220, 44 + rows.length * 10 + extra);
  const config = qz.configs.create(name, {
    units: "mm",
    size: { width: mm, height },
    margins: 0,
    colorType: "blackwhite",
    scaleContent: false,
    interpolation: "nearest-neighbor"
  });
  const ticket = {
    type: "pixel",
    format: "html",
    flavor: "plain",
    data: ticketHtml(order, restaurantName, mm)
  };
  await qz.print(config, [ticket]);
  try {
    await qz.print(config, [
      {
        type: "raw",
        format: "command",
        flavor: "hex",
        data: "1B64041D5601"
      }
    ]);
  } catch {
    // El ticket ya salió. Si el driver ignora el corte, no se vuelve a imprimir.
  }
}
