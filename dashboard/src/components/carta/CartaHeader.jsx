import { forwardRef } from "react";

export function CartaNotice({ theme, lang, title, children }) {
  return (
    <CartaFrame theme={theme} lang={lang}>
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-md rounded-3xl bg-[var(--surface)] p-6 text-center shadow-[var(--shadow)]">
          <p className="carta-serif text-2xl">{title}</p>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{children}</p>
        </div>
      </div>
    </CartaFrame>
  );
}

export const CartaFrame = forwardRef(function CartaFrame({ theme, lang, children }, ref) {
  return (
    <div ref={ref} className="carta" data-theme={theme} lang={lang}>
      {children}
    </div>
  );
});

function initialOf(name) {
  const letter = String(name || "").trim().charAt(0);
  return letter ? letter.toLocaleUpperCase("es-AR") : "M";
}

export default function CartaHeader({ name, subtitle, theme, lang, copy, onToggleTheme, onToggleLang, headerRef }) {
  const light = theme === "light";
  return (
    <header
      ref={headerRef}
      className="carta-header sticky top-0 z-40 bg-[var(--bg)]/95 backdrop-blur"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3 px-4 py-2">
        <span
          aria-hidden="true"
          className="carta-serif grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-lg text-[var(--accent-ink)]"
        >
          {initialOf(name)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="carta-serif truncate text-[1.35rem] font-semibold leading-none tracking-tight">{name}</h1>
          <p className="mt-1 truncate text-xs text-[var(--muted)]">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onToggleLang}
          aria-label={lang === "es" ? copy.langToEn : copy.langToEs}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--surface)] text-xs font-semibold text-[var(--text)]"
        >
          {lang === "es" ? "EN" : "ES"}
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={light ? copy.themeToDark : copy.themeToLight}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--surface)] text-[var(--accent)]"
        >
          {light ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5Z" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}
