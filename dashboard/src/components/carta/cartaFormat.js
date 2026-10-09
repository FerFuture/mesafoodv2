const MARKS = [
  { id: "vegetariano", re: /vegetarian/i },
  { id: "sintacc", re: /sin\s*tacc|sin\s*gluten|gluten[\s-]*free/i },
  { id: "picante", re: /\bpicante\b|\bspicy\b/i }
];

export function formatMenuPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const hasCents = Math.abs(n - Math.round(n)) > 0.001;
  const formatted = new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0
  }).format(n);
  return `$ ${formatted}`;
}

export function displayDishName(name) {
  const text = String(name || "").trim();
  if (!text) return "";
  const lower = text.toLocaleLowerCase("es-AR");
  const upper = text.toLocaleUpperCase("es-AR");
  const base = text === lower || text === upper ? lower : text;
  return base.replace(/(^|[\s(/-])(\p{L})/gu, (_match, sep, letter) => {
    if (text !== lower && text !== upper && sep) return sep + letter;
    return sep + letter.toLocaleUpperCase("es-AR");
  });
}

export function categoryDomId(category) {
  const slug = String(category || "otros")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `carta-${slug || "otros"}`;
}

export function dishMarks(item) {
  const tags = (Array.isArray(item?.tags) ? item.tags : []).filter(
    (tag) => !/^mf(stock|img):/i.test(String(tag || ""))
  );
  const blob = [item?.name, item?.description, item?.category, ...tags].filter(Boolean).join(" ");
  return MARKS.filter((mark) => mark.re.test(blob)).map((mark) => mark.id);
}
