import { useEffect, useRef, useState } from "react";
import { readMenuImage } from "../../lib/menuImage";
import { dishMarks, displayDishName, formatMenuPrice } from "./cartaFormat";

export default function DishModal({ item, qty, viewOnly, canAdd, disabled, onAdd, onRemove, onClose, copy }) {
  const closeRef = useRef(null);
  const startY = useRef(0);
  const [drag, setDrag] = useState(0);
  const [failed, setFailed] = useState(false);
  const imageUrl = readMenuImage(item);
  const showImage = Boolean(imageUrl) && !failed;
  const name = displayDishName(item?.name);
  const marks = dishMarks(item);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function onPointerDown(event) {
    startY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    const next = event.clientY - startY.current;
    if (next > 0) setDrag(next);
  }

  function onPointerUp() {
    if (drag > 90) onClose();
    else setDrag(0);
  }

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/65"
        aria-label={copy.close}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dish-modal-title"
        className="carta-sheet relative z-10 max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[var(--surface)] shadow-[var(--shadow)] sm:rounded-3xl"
        style={drag ? { transform: `translateY(${drag}px)`, animation: "none" } : undefined}
      >
        <div
          className="flex cursor-grab justify-center py-3 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="h-1.5 w-12 rounded-full bg-[var(--muted)]/50" aria-hidden="true" />
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={copy.close}
          className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full bg-[var(--surface)] text-lg text-[var(--text)] shadow-[var(--shadow)]"
        >
          ×
        </button>
        {showImage ? (
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-[var(--surface-2)]">
            <img
              src={imageUrl}
              alt={name}
              className="h-full w-full object-cover"
              onError={() => setFailed(true)}
            />
          </div>
        ) : null}
        <div className="space-y-3 px-4 pb-2 pt-4">
          <h2 id="dish-modal-title" className="carta-serif pr-8 text-3xl font-semibold leading-tight">
            {name}
          </h2>
          {marks.length ? (
            <ul className="flex flex-wrap gap-2">
              {marks.map((id) => (
                <li key={id} className="rounded-full bg-[var(--accent)]/15 px-3 py-1 text-xs font-medium text-[var(--accent)]">
                  {copy[id]}
                </li>
              ))}
            </ul>
          ) : null}
          {item.description ? (
            <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--muted)]">{item.description}</p>
          ) : null}
          <p className="text-2xl font-semibold tabular-nums text-[var(--accent)]">{formatMenuPrice(item.price)}</p>
          {viewOnly ? null : (
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                aria-label={`${copy.remove} ${name}`}
                disabled={qty < 1 || disabled}
                onClick={() => onRemove(item.id)}
                className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface-2)] text-lg disabled:opacity-35"
              >
                −
              </button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums">{qty}</span>
              <button
                type="button"
                aria-label={`${copy.add} ${name}`}
                disabled={!canAdd || disabled}
                onClick={() => onAdd(item.id)}
                className="grid h-11 min-w-11 flex-1 place-items-center rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-ink)] disabled:opacity-35"
              >
                {copy.add}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
