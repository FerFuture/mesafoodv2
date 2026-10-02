const STOCK_TAG = /^mfstock:(\d+)$/;

/** null = este producto no controla cantidad. */
export function readMenuStock(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  for (const tag of tags) {
    const match = String(tag || "").match(STOCK_TAG);
    if (match) return Number(match[1]);
  }
  return null;
}

export function writeMenuStockTags(tags, stock) {
  const next = (Array.isArray(tags) ? tags : []).filter((tag) => !STOCK_TAG.test(String(tag || "")));
  if (stock == null || String(stock).trim() === "") return next;
  const qty = Math.floor(Number(stock));
  if (!Number.isFinite(qty) || qty < 0) return next;
  next.push(`mfstock:${qty}`);
  return next;
}

export function countItemsByName(items) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const name = (typeof item === "string" ? item : String(item?.name || "")).trim().toLowerCase();
    if (!name) continue;
    const rawQty = typeof item === "string" ? 1 : Number(item?.qty ?? item?.quantity ?? 1);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.floor(rawQty) : 1;
    counts.set(name, (counts.get(name) || 0) + qty);
  }
  return counts;
}

export function stockShortage(menuItems, items) {
  const counts = countItemsByName(items);
  const seen = new Set();
  const problems = [];
  for (const item of menuItems || []) {
    const name = String(item?.name || "").trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    const qty = counts.get(name) || 0;
    if (!qty) continue;
    seen.add(name);
    const stock = readMenuStock(item);
    if (stock == null || qty <= stock) continue;
    problems.push({ name: item.name, stock, qty });
  }
  return problems;
}

export function shortageMessage(shortage) {
  if (!shortage?.length) return "";
  const parts = shortage.map((row) =>
    row.stock <= 0 ? `${row.name} está agotado` : `de ${row.name} quedan ${row.stock}`
  );
  return `No hay stock suficiente: ${parts.join("; ")}.`;
}

export function nextStockPatches(menuItems, items, direction) {
  const sign = direction === "restore" ? 1 : -1;
  const counts = countItemsByName(items);
  const seen = new Set();
  const patches = [];
  for (const item of menuItems || []) {
    const name = String(item?.name || "").trim().toLowerCase();
    const qty = counts.get(name) || 0;
    if (!name || !qty || seen.has(name)) continue;
    const stock = readMenuStock(item);
    if (stock == null) continue;
    seen.add(name);
    const next = Math.max(0, stock + sign * qty);
    patches.push({
      id: item.id,
      tags: writeMenuStockTags(item.tags, next),
      available: next > 0
    });
  }
  return patches;
}

export async function applyMenuStock(supabase, restaurantId, items, direction = "consume") {
  if (!restaurantId) return { ok: true, patches: [] };
  const { data, error } = await supabase
    .from("menu_items")
    .select("id, name, tags, available")
    .eq("restaurant_id", restaurantId);
  if (error) return { ok: false, error: error.message, patches: [] };
  if (direction !== "restore") {
    const shortage = stockShortage(data || [], items);
    if (shortage.length) return { ok: false, shortage, patches: [] };
  }
  const patches = nextStockPatches(data || [], items, direction);
  for (const patch of patches) {
    const { error: updateError } = await supabase
      .from("menu_items")
      .update({ tags: patch.tags, available: patch.available })
      .eq("id", patch.id);
    if (updateError) return { ok: false, error: updateError.message, patches };
  }
  return { ok: true, patches };
}
