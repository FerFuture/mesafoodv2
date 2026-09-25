/**
 * Separa una receta pegada en nombre, preparación e ingredientes.
 * Corre en el panel. No llama al VPS.
 */

const UNITS = [
  ["KILOGRAMOS", "KG"],
  ["KILOGRAMO", "KG"],
  ["KILO", "KG"],
  ["KG", "KG"],
  ["GRAMOS", "G"],
  ["GRAMO", "G"],
  ["GRS", "G"],
  ["GR", "G"],
  ["G", "G"],
  ["MILILITROS", "ML"],
  ["MILILITRO", "ML"],
  ["ML", "ML"],
  ["LITROS", "L"],
  ["LITRO", "L"],
  ["L", "L"],
  ["PAQUETES", "PAQUETE"],
  ["PAQUETE", "PAQUETE"],
  ["UNIDADES", "UNIDAD"],
  ["UNIDAD", "UNIDAD"]
];

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function strip(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseIngredientLine(line) {
  const text = strip(String(line || "").replace(/^[-*•]\s*/, ""));
  const match = text.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (!match) return null;
  const quantity = Number(String(match[1]).replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  let rest = strip(match[2]);
  let unit = "UNIDAD";
  const unitMatch = rest.match(/^([a-zA-Z]+)\s+(.+)$/);
  if (unitMatch) {
    const mapped = UNITS.find(([label]) => label === strip(unitMatch[1]).toUpperCase());
    if (mapped) {
      unit = mapped[1];
      rest = strip(unitMatch[2]);
    }
  }
  const name = rest.toUpperCase();
  if (!name) return null;
  return { ingredient_name: name, quantity, unit };
}

function parseRecipe(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const name = lines[0] ? lines[0].slice(0, 80) : "";
  const ingredients = [];
  const preparation = [];
  for (const line of lines.slice(1)) {
    const ingredient = parseIngredientLine(line.replace(/^[-*•]\s*/, ""));
    if (ingredient) ingredients.push(ingredient);
    else preparation.push(line);
  }
  return {
    name,
    preparation: preparation.join("\n"),
    ingredients
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }
  let body = req.body;
  if (body == null || typeof body === "string") {
    try {
      body = JSON.parse(typeof body === "string" && body ? body : await readStream(req));
    } catch {
      body = null;
    }
  }
  const text = String(body?.text || "").trim();
  if (!text) {
    res.status(400).json({ error: "Falta text" });
    return;
  }
  res.status(200).json({ recipe: parseRecipe(text) });
}
