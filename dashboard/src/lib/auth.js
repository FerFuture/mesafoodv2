import bcrypt from "bcryptjs";
import { supabase } from "../supabaseClient";
import {
  deliveryMayLoginToday,
  formatAllowedWeekdaysSentence
} from "./deliverySchedule";

const SESSION_KEY = "restobot_session_v1";
export const SESSION_REVALIDATE_MS = 120_000;

/** Roles que pueden guardarse en sesión (incluye maestro: solo login por env, no alta en BD). */
export const SESSION_ROLES = ["owner", "admin", "encargado", "delivery", "kitchen", "waiter", "maestro"];

/** Roles permitidos en la tabla `dashboard_users`. */
export const DB_USER_ROLES = ["admin", "encargado", "delivery", "kitchen", "waiter"];

export const ROLE_LABELS = {
  owner: "Control",
  admin: "Restaurante (admin)",
  encargado: "Encargado",
  delivery: "Repartidor (delivery)",
  kitchen: "Cocina",
  waiter: "Mozo",
  maestro: "Maestro"
};

const DASHBOARD_USERS_TABLE = "dashboard_users";
const PLATFORM_OWNERS_TABLE = "platform_owners";
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

export function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

/** Misma lógica que el servidor (`index.js`): bcrypt en el cliente evita depender de una API externa en deploy. */
function verifyPasswordLocal(password, passwordHash) {
  const pw = String(password || "");
  const hash = String(passwordHash || "");
  if (!hash) return false;
  try {
    return bcrypt.compareSync(pw, hash);
  } catch {
    return false;
  }
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !SESSION_ROLES.includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
  }
}

function normalizeSessionUpdatedAt(value) {
  return value ? String(value) : "";
}

async function restaurantIsPaused(restaurantId) {
  if (!restaurantId) return true;
  const { data, error } = await supabase
    .from("restaurants")
    .select("status")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error || !data) return false;
  return String(data.status || "active") === "paused";
}

export async function hasPlatformOwner() {
  const { count, error } = await supabase
    .from(PLATFORM_OWNERS_TABLE)
    .select("id", { count: "exact", head: true });
  if (error) {
    return { ok: false, exists: false, error: error.message || "No se pudo consultar la cuenta de control." };
  }
  return { ok: true, exists: (count || 0) > 0, error: "" };
}

export async function createFirstOwner(username, password) {
  const uname = normalizeUsername(username);
  if (!USERNAME_RE.test(uname)) {
    return { ok: false, error: "Usuario: 3–40 caracteres, solo minúsculas, números, . _ -" };
  }
  const pw = String(password || "");
  if (pw.length < 6) {
    return { ok: false, error: "La contraseña debe tener al menos 6 caracteres." };
  }
  const existing = await hasPlatformOwner();
  if (!existing.ok) return { ok: false, error: existing.error };
  if (existing.exists) {
    return { ok: false, error: "Ya existe una cuenta de control. Iniciá sesión con ese usuario." };
  }
  let passwordHash = "";
  try {
    passwordHash = bcrypt.hashSync(pw, 10);
  } catch {
    return { ok: false, error: "No se pudo cifrar la contraseña." };
  }
  const { error } = await supabase.rpc("create_platform_owner", {
    p_username: uname,
    p_password_hash: passwordHash
  });
  if (error) {
    return { ok: false, error: error.message || "No se pudo crear la cuenta de control." };
  }
  return loginWithOwner(uname, pw);
}

export async function validateStoredSession(session = getSession()) {
  if (!session) return { ok: false, reason: "missing" };
  if (session.loginSource !== "db") return { ok: false, reason: "invalid_session" };
  if (session.role === "owner") {
    if (!session.userId) return { ok: false, reason: "invalid_session" };
    const { data, error } = await supabase
      .from(PLATFORM_OWNERS_TABLE)
      .select("id, is_active, updated_at")
      .eq("id", session.userId)
      .maybeSingle();
    if (error) {
      return { ok: true, session, warning: error.message || "No se pudo validar la sesión." };
    }
    if (!data || !data.is_active) return { ok: false, reason: "user_inactive_or_deleted" };
    return { ok: true, session };
  }
  if (!session.userId || !DB_USER_ROLES.includes(session.role)) {
    return { ok: false, reason: "invalid_session" };
  }

  const { data, error } = await supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, role, is_active, updated_at, restaurant_id")
    .eq("id", session.userId)
    .maybeSingle();

  if (error) {
    return { ok: true, session, warning: error.message || "No se pudo validar la sesión." };
  }
  if (!data || !data.is_active) {
    return { ok: false, reason: "user_inactive_or_deleted" };
  }
  if (data.role !== session.role) {
    return { ok: false, reason: "role_changed" };
  }
  if (!data.restaurant_id || data.restaurant_id !== session.restaurantId) {
    return { ok: false, reason: "role_changed" };
  }
  if (await restaurantIsPaused(data.restaurant_id)) {
    return { ok: false, reason: "restaurant_paused" };
  }

  const dbUpdatedAt = normalizeSessionUpdatedAt(data.updated_at);
  const sessionUpdatedAt = normalizeSessionUpdatedAt(session.userUpdatedAt);
  if (!sessionUpdatedAt) {
    const nextSession = { ...session, userUpdatedAt: dbUpdatedAt };
    saveSession(nextSession);
    return { ok: true, session: nextSession };
  }
  if (dbUpdatedAt && dbUpdatedAt !== sessionUpdatedAt) {
    return { ok: false, reason: "user_updated" };
  }

  return { ok: true, session };
}

async function loginWithOwner(username, password) {
  const { data, error } = await supabase
    .from(PLATFORM_OWNERS_TABLE)
    .select("id, password_hash, is_active, updated_at")
    .eq("username", username)
    .maybeSingle();
  if (error) {
    if (error.code === "42P01" || (error.message || "").includes("does not exist")) {
      return { ok: false, missingTable: true };
    }
    return { ok: false, error: `Error de acceso: ${error.message}` };
  }
  if (!data) return { ok: false, missingUser: true };
  if (!data.is_active) return { ok: false, error: "Usuario o contraseña incorrectos." };
  if (!verifyPasswordLocal(String(password || ""), data.password_hash)) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  const session = {
    role: "owner",
    username,
    userId: data.id,
    userUpdatedAt: normalizeSessionUpdatedAt(data.updated_at),
    loginSource: "db",
    loggedInAt: new Date().toISOString()
  };
  saveSession(session);
  return { ok: true, session };
}

async function loginWithTableUser(username, password) {
  const norm = normalizeUsername(username);
  if (!norm) {
    return { ok: false, error: "Ingresá tu usuario y contraseña." };
  }

  const ownerResult = await loginWithOwner(norm, password);
  if (ownerResult.ok) return ownerResult;
  if (ownerResult.error && !ownerResult.missingUser && !ownerResult.missingTable) {
    return ownerResult;
  }

  const { data, error } = await supabase
    .from(DASHBOARD_USERS_TABLE)
    .select("id, password_hash, role, is_active, delivery_work_weekdays, updated_at, restaurant_id")
    .eq("username", norm)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" || (error.message || "").includes("does not exist")) {
      return {
        ok: false,
        error: "Acceso de usuarios no disponible. Contactá al administrador."
      };
    }
    return { ok: false, error: `Error de acceso: ${error.message}` };
  }
  if (!data || !data.is_active) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (!DB_USER_ROLES.includes(data.role)) {
    return { ok: false, error: "Rol inválido en la base de datos." };
  }
  const ok = verifyPasswordLocal(String(password || ""), data.password_hash);
  if (!ok) {
    return { ok: false, error: "Usuario o contraseña incorrectos." };
  }
  if (!data.restaurant_id) {
    return { ok: false, error: "Este usuario no está asignado a un local." };
  }
  const { data: restaurant, error: restaurantError } = await supabase
    .from("restaurants")
    .select("id, name, status")
    .eq("id", data.restaurant_id)
    .maybeSingle();
  if (restaurantError || !restaurant) {
    return { ok: false, error: "No se encontró el local de este usuario." };
  }
  if (String(restaurant.status || "active") === "paused") {
    return { ok: false, error: "Este local está pausado. El acceso vuelve cuando se reactive." };
  }
  if (
    data.role === "delivery" &&
    !deliveryMayLoginToday(data.delivery_work_weekdays)
  ) {
    const hint = formatAllowedWeekdaysSentence(data.delivery_work_weekdays);
    return {
      ok: false,
      error: `Hoy no podés entrar con esta cuenta de reparto. Días habilitados: ${hint}.`
    };
  }
  const session = {
    role: data.role,
    username: norm,
    userId: data.id,
    restaurantId: data.restaurant_id,
    restaurantName: restaurant.name || "",
    userUpdatedAt: normalizeSessionUpdatedAt(data.updated_at),
    loginSource: "db",
    loggedInAt: new Date().toISOString()
  };
  saveSession(session);
  return { ok: true, session };
}

export async function login(p) {
  const username = String(p?.username || "").trim();
  if (!username) {
    return { ok: false, error: "Ingresá tu usuario y contraseña." };
  }
  return loginWithTableUser(username, p.password);
}

export function logout() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
  }
}
