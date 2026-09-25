/**
 * Abre la visita de una mesa. El pedido QR tiene que mandar este sello.
 * Si la mesa se cobra después, esa visita ya no puede pedir.
 */

import { envFirst, getRawBody, signVisitToken, supabaseFetch, tokenMatches } from "./order.js";

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
    const mesaToken = body?.mesaToken;
    if (!restaurantId) return res.status(400).json({ error: "Falta restaurantId" });
    if (!Number.isFinite(tableNumber) || tableNumber < 1) {
      return res.status(400).json({ error: "tableNumber inválido" });
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

    const openedAt = new Date().toISOString();
    let qrOpen = false;
    try {
      const restaurants = await supabaseFetch(
        `restaurants?id=eq.${encodeURIComponent(restaurantId)}&select=metadata&limit=1`
      );
      const restaurant = Array.isArray(restaurants) ? restaurants[0] : null;
      const metadata =
        restaurant?.metadata && typeof restaurant.metadata === "object" && !Array.isArray(restaurant.metadata)
          ? restaurant.metadata
          : {};
      const liveTables = Array.isArray(metadata.mesa_qr_live_tables)
        ? metadata.mesa_qr_live_tables.map((entry) => Number(entry))
        : [];
      qrOpen = liveTables.includes(tableNumber);
    } catch {
      qrOpen = false;
    }
    return res.status(200).json({
      openedAt,
      visitToken: signVisitToken(secret, restaurantId, tableNumber, openedAt),
      qrOpen
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return res.status(status).json({ error: error?.message || "No se pudo abrir la mesa" });
  }
}
