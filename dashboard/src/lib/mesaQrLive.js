/** Mesas en las que el mozo dejó abierto el pedido desde el QR. */
export function liveMesaTables(metadata) {
  const raw = metadata?.mesa_qr_live_tables;
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry >= 1)
    )
  ].sort((a, b) => a - b);
}

export async function setMesaQrLive(supabase, restaurantId, tableNumber, live) {
  const table = Number(tableNumber);
  const id = String(restaurantId || "").trim();
  if (!id || !Number.isFinite(table) || table < 1) {
    return { error: { message: "Mesa inválida" }, metadata: null };
  }
  const { data, error } = await supabase
    .from("restaurants")
    .select("metadata")
    .eq("id", id)
    .maybeSingle();
  if (error) return { error, metadata: null };
  const metadata =
    data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? { ...data.metadata }
      : {};
  const tables = new Set(liveMesaTables(metadata));
  if (live) tables.add(table);
  else tables.delete(table);
  metadata.mesa_qr_live_tables = [...tables];
  const updated = await supabase.from("restaurants").update({ metadata }).eq("id", id);
  if (updated.error) return { error: updated.error, metadata: null };
  return { error: null, metadata };
}
