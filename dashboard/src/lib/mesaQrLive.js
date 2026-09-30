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

/** El mozo o el encargado piden la cuenta. La PC de cocina la imprime en la otra impresora. */
export async function requestBillPrint(supabase, restaurantId, { tableNumber, orderIds, requestedBy }) {
  const id = String(restaurantId || "").trim();
  const ids = [...new Set((orderIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!id || !ids.length) {
    return { error: { message: "No hay pedidos para imprimir" } };
  }
  const { data, error } = await supabase
    .from("restaurants")
    .select("metadata")
    .eq("id", id)
    .maybeSingle();
  if (error) return { error };
  const metadata =
    data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? { ...data.metadata }
      : {};
  const jobs = Array.isArray(metadata.bill_print_jobs) ? metadata.bill_print_jobs : [];
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    tableNumber: tableNumber == null ? "" : String(tableNumber),
    orderIds: ids,
    requestedBy: String(requestedBy || "").trim()
  };
  metadata.bill_print_jobs = [...jobs, job].slice(-30);
  const updated = await supabase.from("restaurants").update({ metadata }).eq("id", id);
  if (updated.error) return { error: updated.error };
  return { error: null, job };
}
