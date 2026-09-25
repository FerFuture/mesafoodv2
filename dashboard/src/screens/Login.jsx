import { useEffect, useState } from "react";
import { createFirstOwner, hasPlatformOwner, login } from "../lib/auth";

export default function Login({ onLoggedIn, sessionNotice = "" }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [checkingOwner, setCheckingOwner] = useState(true);

  useEffect(() => {
    let cancelled = false;
    hasPlatformOwner().then((result) => {
      if (cancelled) return;
      setCheckingOwner(false);
      if (!result.ok) {
        setError(result.error || "No se pudo consultar la cuenta de control. Corré el SQL de MesaFood v2 en Supabase.");
        return;
      }
      if (!result.exists) setNeedsOwner(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const usernameTrim = username.trim();

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = needsOwner
        ? await createFirstOwner(usernameTrim, password)
        : await login({
            password,
            username: usernameTrim
          });
      if (!result.ok) {
        setError(result.error || "No se pudo iniciar sesión.");
        return;
      }
      setPassword("");
      onLoggedIn?.(result.session);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dark min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight">MesaFood</h1>
          <p className="mt-1 text-sm text-slate-400">
            {needsOwner
              ? "Creá tu usuario de control. Con esa cuenta vas a dar de alta cada local."
              : "Entrá con tu usuario. El personal de cada local usa el suyo."}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur"
        >
          <div className="mb-4">
            <label
              htmlFor="login-username"
              className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-400"
            >
              Usuario
            </label>
            <input
              id="login-username"
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setError("");
              }}
              placeholder="ej: cocina1"
              className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="mb-4">
            <label
              htmlFor="login-password"
              className="mb-2 block text-xs font-medium uppercase tracking-wider text-slate-400"
            >
              Contraseña
            </label>
            <input
              id="login-password"
              type="password"
              autoFocus
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          {sessionNotice ? (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {sessionNotice}
            </div>
          ) : null}

          {error ? (
            <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting || checkingOwner}
            className="h-11 w-full rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {submitting ? "Ingresando…" : needsOwner ? "Crear cuenta de control" : "Ingresar"}
          </button>
        </form>
      </div>
    </div>
  );
}
