export default function CartaFooter({ name, address, openingHours, whatsapp, copy }) {
  const href = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(copy.waPrefill)}` : "";
  if (!name && !address && !openingHours && !href) return null;

  return (
    <footer className="mx-auto w-full max-w-[1100px] px-4 pb-8 pt-10 text-sm text-[var(--muted)]">
      <p className="carta-serif text-xl text-[var(--text)]">{name}</p>
      {openingHours ? (
        <p className="mt-3">
          <span className="text-[var(--text)]">{copy.hours}. </span>
          {openingHours}
        </p>
      ) : null}
      {address ? <p className="mt-2">{address}</p> : null}
      {href ? (
        <a href={href} className="mt-4 inline-flex h-11 items-center font-semibold text-[var(--accent)]" target="_blank" rel="noreferrer">
          {copy.whatsapp}
        </a>
      ) : null}
    </footer>
  );
}

export function WhatsappFab({ whatsapp, copy, lifted }) {
  if (!whatsapp) return null;
  const href = `https://wa.me/${whatsapp}?text=${encodeURIComponent(copy.waPrefill)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={copy.whatsapp}
      className="fixed right-4 z-30 grid h-12 w-12 place-items-center rounded-full bg-[#25D366] text-white shadow-[var(--shadow)]"
      style={{ bottom: lifted ? "calc(env(safe-area-inset-bottom) + 6.5rem)" : "calc(env(safe-area-inset-bottom) + 1rem)" }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.5 3.5A11 11 0 0 0 2.1 17.2L1 23l5.9-1.1A11 11 0 0 0 20.5 3.5Zm-8.5 17a9.1 9.1 0 0 1-4.6-1.3l-.3-.2-3.5.7.7-3.4-.2-.3A9.1 9.1 0 1 1 12 20.5Zm5-6.8c-.3-.1-1.6-.8-1.8-.9s-.4-.1-.6.1-.7.9-.8 1-.3.2-.6.1a7.4 7.4 0 0 1-2.2-1.4 8.2 8.2 0 0 1-1.5-1.9c-.2-.3 0-.4.1-.6l.4-.5.2-.3a.5.5 0 0 0 0-.5c0-.1-.6-1.4-.8-1.9s-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4 15 15 0 0 0 1.5.6 3.6 3.6 0 0 0 1.7.1 2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.6-.3Z" />
      </svg>
    </a>
  );
}
