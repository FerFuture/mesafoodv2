/**
 * Pedido de carta QR. Se guarda en Supabase desde este proyecto.
 * No usa VPS, Mercado Pago ni efectivo: el pedido queda confirmado para cocina.
 *
 * Secreto: MESA_QR_SECRET o VITE_MESA_QR_SECRET (el mismo del QR).
 * Base: SUPABASE_URL / VITE_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY o VITE_SUPABASE_KEY.
 */

import crypto from "crypto";

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function getRawBody(req) {
  if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string" && req.body.length > 0) {
    return JSON.parse(req.body);
  }
  const fromStream = await readStream(req);
  if (!fromStream) return null;
  return JSON.parse(fromStream);
}

export function envFirst(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function supabaseConfig() {
  return {
    url: envFirst("SUPABASE_URL", "VITE_SUPABASE_URL").replace(/\/$/, ""),
    key: envFirst("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "VITE_SUPABASE_KEY")
  };
}

export function tokenMatches(restaurantId, tableNumber, token, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${restaurantId}|${tableNumber}`)
    .digest("hex");
  const a = Buffer.from(String(token || "").trim(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function signVisitToken(secret, restaurantId, tableNumber, openedAt) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${restaurantId}|${tableNumber}|${openedAt}`)
    .digest("hex");
}

function visitTokenMatches(secret, restaurantId, tableNumber, openedAt, token) {
  const expected = signVisitToken(secret, restaurantId, tableNumber, openedAt);
  const a = Buffer.from(String(token || "").trim(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function supabaseFetch(path, { method = "GET", body } = {}) {
  const { url, key } = supabaseConfig();
  if (!url || !key) {
    const error = new Error("Faltan SUPABASE_URL y la clave en el proyecto de Vercel.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: method === "GET" ? "return=representation" : "return=representation"
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message =
      (data && typeof data === "object" && (data.message || data.error)) ||
      `Error de base de datos (${response.status})`;
    const error = new Error(message);
    error.status = 502;
    throw error;
  }
  return data;
}

function blockedTables(metadata, maxTableCount) {
  const raw = metadata?.mesa_qr_blocked_tables;
  if (!Array.isArray(raw)) return [];
  const max = Number.isFinite(maxTableCount) && maxTableCount >= 1 ? Math.floor(maxTableCount) : 500;
  return raw.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= max);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  try {
    const body = await getRawBody(req);
    const restaurantId = String(body?.restaurantId || "").trim();
    const tableNumber = Number(body?.tableNumber);
    const items = body?.items;
    const mesaToken = body?.mesaToken;
    if (!restaurantId) return res.status(400).json({ error: "Falta restaurantId" });
    if (!Number.isFinite(tableNumber) || tableNumber < 1) {
      return res.status(400).json({ error: "tableNumber inválido" });
    }
    if (!Array.isArray(items) || items.length < 1) {
      return res.status(400).json({ error: "items inválidos" });
    }

    const secret = envFirst("MESA_QR_SECRET", "VITE_MESA_QR_SECRET");
    if (!secret) {
      return res.status(503).json({
        error: "Falta VITE_MESA_QR_SECRET en Vercel. Cargalo y volvé a desplegar."
      });
    }
    if (!tokenMatches(restaurantId, tableNumber, mesaToken, secret)) {
      return res.status(403).json({ error: "Token de mesa inválido. Volvé a escanear el QR." });
    }

    const openedAt = String(body?.openedAt || "").trim();
    const visitToken = String(body?.visitToken || "").trim();
    const openedMs = Date.parse(openedAt);
    if (!openedAt || !Number.isFinite(openedMs)) {
      return res.status(400).json({
        error: "Volvé a escanear el QR de la mesa.",
        code: "visit_required"
      });
    }
    if (!visitTokenMatches(secret, restaurantId, tableNumber, openedAt, visitToken)) {
      return res.status(403).json({
        error: "La visita no es válida. Escaneá de nuevo el QR de la mesa.",
        code: "visit_invalid"
      });
    }
    const paidAfterOpen = await supabaseFetch(
      `orders?restaurant_id=eq.${encodeURIComponent(restaurantId)}&table_number=eq.${tableNumber}&fulfillment_type=eq.mesa&payment_status=in.(paid,approved)&payment_paid_at=gte.${encodeURIComponent(new Date(openedMs).toISOString())}&select=id&limit=1`
    );
    if (Array.isArray(paidAfterOpen) && paidAfterOpen.length > 0) {
      return res.status(409).json({
        error: "La cuenta de esta mesa ya se cerró. Si seguís en la mesa, escaneá el QR otra vez.",
        code: "visit_closed"
      });
    }

    const restaurants = await supabaseFetch(
      `restaurants?id=eq.${encodeURIComponent(restaurantId)}&select=id,whatsapp_number,table_count,status,metadata&limit=1`
    );
    const restaurant = Array.isArray(restaurants) ? restaurants[0] : null;
    if (!restaurant) return res.status(404).json({ error: "Restaurante no encontrado" });
    if (String(restaurant.status || "active") === "paused") {
      return res.status(409).json({ error: "Este local está pausado." });
    }

    const metadata =
      restaurant.metadata && typeof restaurant.metadata === "object" && !Array.isArray(restaurant.metadata)
        ? restaurant.metadata
        : {};
    if (metadata.mesa_qr_enabled === false) {
      return res.status(409).json({ error: "Carta QR por mesas deshabilitada" });
    }
    const liveTables = Array.isArray(metadata.mesa_qr_live_tables)
      ? metadata.mesa_qr_live_tables.map((entry) => Number(entry))
      : [];
    if (!liveTables.includes(tableNumber)) {
      return res.status(409).json({
        error: "Esta mesa no está habilitada. Pedile al mozo que la habilite para pedir desde el celular.",
        code: "table_locked"
      });
    }
    const maxTables = Number(restaurant.table_count);
    if (Number.isFinite(maxTables) && maxTables > 0 && tableNumber > maxTables) {
      return res.status(400).json({ error: `Mesa fuera de rango (max ${maxTables}).` });
    }
    if (blockedTables(metadata, maxTables).includes(tableNumber)) {
      return res.status(409).json({ error: `La mesa ${tableNumber} está bloqueada para pedidos QR.` });
    }

    const menu = await supabaseFetch(
      `menu_items?restaurant_id=eq.${encodeURIComponent(restaurantId)}&available=eq.true&select=name,price`
    );
    const menuByName = new Map();
    for (const item of menu || []) {
      const name = String(item?.name || "").trim();
      const price = Number(item?.price || 0);
      if (!name || !Number.isFinite(price) || price <= 0) continue;
      menuByName.set(name, { name, price });
    }

    const resolvedItems = [];
    let totalAmount = 0;
    for (const item of items) {
      const name = typeof item === "string" ? String(item || "").trim() : String(item?.name || item?.title || "").trim();
      const match = menuByName.get(name);
      if (!match) return res.status(400).json({ error: `Producto no disponible: ${name}` });
      resolvedItems.push({ name: match.name, price: match.price });
      totalAmount += match.price;
    }
    totalAmount = Math.round(totalAmount * 100) / 100;
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ error: "Total inválido" });
    }

    const botNumber = String(restaurant.whatsapp_number || "").replace(/\D/g, "") || "0";
    const observacion = String(body?.observacion || "").trim().slice(0, 400);
    const orderRow = {
      restaurant_id: restaurantId,
      customer_number: "",
      bot_number: botNumber,
      items: resolvedItems,
      notes: `Mesa: ${tableNumber}`,
      status: "confirmed",
      payment_method: "efectivo_mesa",
      payment_status: "pending",
      payment_paid_at: null,
      fulfillment_type: "mesa",
      table_number: tableNumber,
      total_price: totalAmount,
      total_amount: totalAmount,
      subtotal_amount: totalAmount
    };
    if (observacion) orderRow.observacion = observacion;
    const created = await supabaseFetch("orders", {
      method: "POST",
      body: orderRow
    });
    const order = Array.isArray(created) ? created[0] : created;
    return res.status(200).json({ orderId: order?.id || null });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "No se pudo enviar el pedido" });
  }
}
