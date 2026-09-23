/**
 * The per-card actions menu in the project gallery.
 *
 * Rename / duplicate / delete used to sit on every card as three glyphs, always
 * visible: fifteen icons on a five-project gallery, competing with the five
 * things the cards are actually about. They live behind one "⋯" now, revealed on
 * hover — and on focus, so a keyboard can still reach them.
 *
 * Delete is the reason this is a menu rather than a row of buttons: a bare "×"
 * sat a few pixels from "open this project", and a misclick deleted somebody's
 * setup. Here it is a labelled item, set apart, in the danger colour.
 */
import { useEffect, useRef, useState } from "react";

export type CardAction = {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
};

export default function CardMenu({
  label,
  actions,
  disabled = false,
}: {
  /** Accessible name for the trigger — the menu itself has no visible title. */
  label: string;
  actions: CardAction[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstItem.current?.focus();

    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    // Capture: the card underneath treats a click as "open this project", and a
    // click-away that closes the menu must not also open it.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // Every click in here is about the card, not about opening it.
  const contain = (e: React.MouseEvent | React.KeyboardEvent) => e.stopPropagation();

  return (
    <div className="card-menu" ref={root} onClick={contain} onKeyDown={contain}>
      <button
        ref={trigger}
        className="card-menu-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="card-menu-pop" role="menu">
          {actions.map((action, i) => (
            <button
              key={action.key}
              ref={i === 0 ? firstItem : undefined}
              role="menuitem"
              className={action.danger ? "card-menu-item danger" : "card-menu-item"}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
