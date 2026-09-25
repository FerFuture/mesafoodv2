import { useCallback, useEffect, useState } from "react";
import bcrypt from "bcryptjs";
import { supabase } from "../supabaseClient";

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

function hashPassword(password) {
  const pw = String(password || "");
  if (pw.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
  return bcrypt.hashSync(pw, 10);
}

const emptyLocal = {
  name: "",
  publicName: "",
  whatsappNumber: "",
  address: ""
};

export default function ControlPanel({ onLogout, username = "" }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState(emptyLocal);
  const [savingLocal, setSavingLocal] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [deleteDraft, setDeleteDraft] = useState({ id: "", name: "" });
  const [userDrafts, setUserDrafts] = useState({});

  const load = useCallback(async () => {
    setError("");
    const { data, error: queryError } = await supabase
      .from("restaurants")
      .select("id, name, public_name, whatsapp_number, address, status, created_at")
      .order("created_at", { ascending: true });
    if (queryError) {
      setError(queryError.message || "No se pudieron cargar los locales.");
      setRows([]);
      setLoading(false);
      return;
    }
    const list = data || [];
    let counts = {};
    if (list.length) {
      const { data: users } = await supabase.from("dashboard_users").select("restaurant_id");
      counts = (users || []).reduce((acc, row) => {
        const id = row.restaurant_id;
        if (!id) return acc;
        acc[id] = (acc[id] || 0) + 1;
        return acc;
      }, {});
    }
    setRows(list.map((row) => ({ ...row, userCount: counts[row.id] || 0 })));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createLocal(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    const name = draft.name.trim();
    if (!name) {
      setError("El nombre del local es obligatorio.");
      return;
    }
    const whatsapp = String(draft.whatsappNumber || "").replace(/\D/g, "");
    setSavingLocal(true);
    const { error: insertError } = await supabase.from("restaurants").insert({
      name,
      public_name: draft.publicName.trim() || null,
      whatsapp_number: whatsapp || null,
      address: draft.address.trim() || null,
      status: "active",
      metadata: {}
    });
    setSavingLocal(false);
    if (insertError) {
      setError(
        insertError.code === "23505"
          ? "Ese número de WhatsApp ya está usado por otro local."
          : insertError.message
      );
      return;
    }
    setDraft(emptyLocal);
    setNotice(`Listo. "${name}" ya está en la base. Creale un usuario admin para que puedan entrar.`);
    await load();
  }

  async function setStatus(row, status) {
    setError("");
    setNotice("");
    setBusyId(row.id);
    const { error: updateError } = await supabase
      .from("restaurants")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    setBusyId("");
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setNotice(status === "paused" ? `${row.name} quedó pausado.` : `${row.name} volvió a estar activo.`);
    await load();
  }

  async function removeLocal(row) {
    if (deleteDraft.name.trim() !== row.name) {
      setError(`Para borrar, escribí el nombre exacto: ${row.name}`);
      return;
    }
    setError("");
    setNotice("");
    setBusyId(row.id);
    const { error: deleteError } = await supabase.from("restaurants").delete().eq("id", row.id);
    setBusyId("");
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setDeleteDraft({ id: "", name: "" });
    setNotice(`${row.name} y sus datos se borraron. Los otros locales no se tocaron.`);
    await load();
  }

  async function createAdmin(row) {
    const draftUser = userDrafts[row.id] || { username: "", password: "" };
    const username = String(draftUser.username || "").trim().toLowerCase();
    const password = String(draftUser.password || "");
    setError("");
    setNotice("");
    if (!USERNAME_RE.test(username)) {
      setError("Usuario: 3–40 caracteres, solo minúsculas, números, punto, guion o guion bajo.");
      return;
    }
    if (password.length < 6) {
      setError("La contraseña del admin debe tener al menos 6 caracteres.");
      return;
    }
    setBusyId(`${row.id}:user`);
    let passwordHash = "";
    try {
      passwordHash = hashPassword(password);
    } catch (hashError) {
      setBusyId("");
      setError(hashError.message);
      return;
    }
    const { error: insertError } = await supabase.from("dashboard_users").insert({
      restaurant_id: row.id,
      username,
      password_hash: passwordHash,
      role: "admin",
      is_active: true,
      updated_at: new Date().toISOString()
    });
    setBusyId("");
    if (insertError) {
      setError(insertError.code === "23505" ? "Ese usuario ya existe." : insertError.message);
      return;
    }
    setUserDrafts((prev) => ({ ...prev, [row.id]: { username: "", password: "" } }));
    setNotice(`Usuario "${username}" creado para ${row.name}. Entra con ese usuario en esta misma dirección.`);
    await load();
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-emerald-300/80">MesaFood</p>
            <h1 className="text-2xl font-semibold tracking-tight">Control de locales</h1>
            <p className="mt-1 text-sm text-slate-400">
              {username ? `${username} · ` : ""}
              Un local no ve los pedidos ni los usuarios de otro.
            </p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
          >
            Salir
          </button>
        </header>

        {error ? (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
            {notice}
          </div>
        ) : null}

        <form onSubmit={createLocal} className="mb-8 space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Nuevo local</h2>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-400">Nombre</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"
              placeholder="Ej: Local Centro"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-400">Nombre público</span>
            <input
              value={draft.publicName}
              onChange={(event) => setDraft((prev) => ({ ...prev, publicName: event.target.value }))}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"
              placeholder="Como lo ven los clientes"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-400">Dirección</span>
            <input
              value={draft.address}
              onChange={(event) => setDraft((prev) => ({ ...prev, address: event.target.value }))}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-400">WhatsApp del local (opcional)</span>
            <input
              value={draft.whatsappNumber}
              onChange={(event) => setDraft((prev) => ({ ...prev, whatsappNumber: event.target.value }))}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"
              placeholder="Solo si más adelante vas a conectar el bot"
              inputMode="tel"
            />
          </label>
          <button
            type="submit"
            disabled={savingLocal}
            className="h-10 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
          >
            {savingLocal ? "Creando…" : "Crear local"}
          </button>
        </form>

        {loading ? <p className="text-sm text-slate-400">Cargando locales…</p> : null}

        <div className="space-y-4">
          {rows.map((row) => {
            const paused = row.status === "paused";
            const userDraft = userDrafts[row.id] || { username: "", password: "" };
            const deleting = deleteDraft.id === row.id;
            return (
              <article key={row.id} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">{row.public_name || row.name}</h3>
                    <p className="text-sm text-slate-400">{row.name}</p>
                    {row.address ? <p className="mt-1 text-sm text-slate-500">{row.address}</p> : null}
                    <p className="mt-2 text-xs text-slate-500">
                      {row.userCount} usuario{row.userCount === 1 ? "" : "s"}
                      {row.whatsapp_number ? ` · WhatsApp ${row.whatsapp_number}` : ""}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      paused
                        ? "bg-amber-500/15 text-amber-200"
                        : "bg-emerald-500/15 text-emerald-200"
                    }`}
                  >
                    {paused ? "Pausado" : "Activo"}
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => setStatus(row, paused ? "active" : "paused")}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60"
                  >
                    {paused ? "Reactivar" : "Pausar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteDraft(deleting ? { id: "", name: "" } : { id: row.id, name: "" })}
                    className="rounded-lg border border-rose-500/40 px-3 py-2 text-sm text-rose-200 hover:bg-rose-500/10"
                  >
                    Borrar
                  </button>
                </div>

                {deleting ? (
                  <div className="mt-3 space-y-2 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3">
                    <p className="text-sm text-rose-100">
                      Se borran la carta, los pedidos y los usuarios de este local. Escribí <strong>{row.name}</strong> para confirmar.
                    </p>
                    <input
                      value={deleteDraft.name}
                      onChange={(event) => setDeleteDraft({ id: row.id, name: event.target.value })}
                      className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => removeLocal(row)}
                      className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      Borrar este local
                    </button>
                  </div>
                ) : null}

                <form
                  className="mt-4 grid gap-2 border-t border-slate-800 pt-4 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    createAdmin(row);
                  }}
                >
                  <p className="sm:col-span-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                    Usuario admin de este local
                  </p>
                  <input
                    value={userDraft.username}
                    onChange={(event) =>
                      setUserDrafts((prev) => ({
                        ...prev,
                        [row.id]: { ...userDraft, username: event.target.value }
                      }))
                    }
                    placeholder="usuario"
                    className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                    autoComplete="off"
                  />
                  <input
                    type="password"
                    value={userDraft.password}
                    onChange={(event) =>
                      setUserDrafts((prev) => ({
                        ...prev,
                        [row.id]: { ...userDraft, password: event.target.value }
                      }))
                    }
                    placeholder="contraseña"
                    className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                    autoComplete="new-password"
                  />
                  <button
                    type="submit"
                    disabled={busyId === `${row.id}:user`}
                    className="h-10 rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-950 disabled:opacity-60 sm:col-span-2 sm:w-fit"
                  >
                    {busyId === `${row.id}:user` ? "Creando…" : "Crear admin"}
                  </button>
                </form>
              </article>
            );
          })}
          {!loading && rows.length === 0 ? (
            <p className="text-sm text-slate-500">Todavía no hay locales. Creá el primero arriba.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
