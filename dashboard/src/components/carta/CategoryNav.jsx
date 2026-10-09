import { useEffect, useRef } from "react";
import { categoryDomId, displayDishName } from "./cartaFormat";

export default function CategoryNav({ categories, active, onSelect, copy, navRef }) {
  const scrollerRef = useRef(null);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !active) return;
    const chip = root.querySelector(`[data-cat="${categoryDomId(active)}"]`);
    if (!chip) return;
    const left = chip.offsetLeft - (root.clientWidth - chip.offsetWidth) / 2;
    root.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [active]);

  if (!categories.length) return null;

  return (
    <nav ref={navRef} className="carta-sticky-nav bg-[var(--bg)]/95 backdrop-blur" aria-label={copy.categories}>
      <div className="mx-auto w-full max-w-[1100px]">
        <div ref={scrollerRef} className="carta-chips flex gap-2 overflow-x-auto px-4 py-2">
          {categories.map((category) => {
            const selected = category === active;
            return (
              <button
                key={category}
                type="button"
                data-cat={categoryDomId(category)}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(category)}
                className={`h-11 shrink-0 rounded-full px-4 text-sm font-medium transition-colors duration-200 ${
                  selected
                    ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                    : "bg-[var(--surface)] text-[var(--muted)]"
                }`}
              >
                {displayDishName(category)}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
