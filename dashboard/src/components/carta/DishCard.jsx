import { useState } from "react";
import { readMenuImage } from "../../lib/menuImage";
import { dishMarks, displayDishName, formatMenuPrice } from "./cartaFormat";

function CartaPhoto({ src, alt, className, onFail }) {
  const [ready, setReady] = useState(false);
  return (
    <span className={`relative block overflow-hidden bg-[var(--surface-2)] ${className}`}>
      {ready ? null : <span className="carta-photo-wait absolute inset-0" aria-hidden="true" />}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setReady(true)}
        onError={onFail}
        className={`h-full w-full object-cover transition-opacity duration-200 ${ready ? "opacity-100" : "opacity-0"}`}
      />
    </span>
  );
}

export default function DishCard({ item, qty, viewOnly, canAdd, disabled, onOpen, onAdd, onRemove, copy, index }) {
  const imageUrl = readMenuImage(item);
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;
  const name = displayDishName(item.name);
  const marks = dishMarks(item);

  return (
    <article
      className="carta-card relative overflow-hidden rounded-2xl bg-[var(--surface)] shadow-[var(--shadow)]"
      style={{ animationDelay: `${(index % 8) * 30}ms` }}
    >
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className={`flex w-full items-start gap-3 p-3 text-left transition-transform duration-200 active:scale-[0.98] ${
          showImage ? "lg:flex-col lg:gap-0 lg:p-0" : ""
        } ${viewOnly ? "" : "pb-[4.25rem] lg:pb-16"}`}
      >
        <div className={`min-w-0 flex-1 ${showImage ? "lg:order-2 lg:px-4 lg:pb-2 lg:pt-3" : ""}`}>
          <h3 className="carta-serif text-[1.08rem] font-semibold leading-snug text-[var(--text)]">{name}</h3>
          {item.description ? (
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-[var(--muted)]">{item.description}</p>
          ) : null}
          <p className="mt-2 text-base font-semibold tabular-nums text-[var(--accent)]">{formatMenuPrice(item.price)}</p>
          {marks.length ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {marks.map((id) => (
                <li
                  key={id}
                  className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]"
                >
                  {copy[id]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {showImage ? (
          <CartaPhoto
            src={imageUrl}
            alt={name}
            onFail={() => setFailed(true)}
            className="h-[104px] w-[104px] shrink-0 rounded-[12px] lg:order-1 lg:aspect-[4/3] lg:h-auto lg:w-full lg:rounded-none"
          />
        ) : null}
      </button>
      {viewOnly ? null : (
        <div className="absolute bottom-2 left-3 flex items-center gap-1">
          <button
            type="button"
            aria-label={`${copy.remove} ${name}`}
            disabled={qty < 1 || disabled}
            onClick={() => onRemove(item.id)}
            className="grid h-11 w-11 place-items-center rounded-full bg-[var(--surface-2)] text-lg text-[var(--text)] disabled:opacity-35"
          >
            −
          </button>
          <span className="w-6 text-center text-sm font-semibold tabular-nums" aria-live="polite">
            {qty}
          </span>
          <button
            type="button"
            aria-label={`${copy.add} ${name}`}
            disabled={!canAdd || disabled}
            onClick={() => onAdd(item.id)}
            className="grid h-11 w-11 place-items-center rounded-full bg-[var(--accent)] text-lg font-semibold text-[var(--accent-ink)] disabled:opacity-35"
          >
            +
          </button>
        </div>
      )}
    </article>
  );
}
