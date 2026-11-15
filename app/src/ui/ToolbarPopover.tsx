/**
 * A toolbar button that opens a small floating panel beneath it.
 *
 * The editor toolbar wrapped onto two lines on a 13" laptop, and worse in
 * Japanese: seventeen controls at equal weight in one row. The rarely used
 * ones (theme, language, build-from-photo, pins) now live behind two of these —
 * the settings chip and "⋯" — so the row fits and the everyday controls stand
 * out.
 *
 * Closes on Esc (focus returns to the trigger), on a click outside, and when
 * `close()` is called from inside — e.g. after a menu item has been chosen.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export default function ToolbarPopover({
  triggerClassName = "",
  triggerContent,
  label,
  title,
  popClassName = "",
  role = "dialog",
  children,
}: {
  triggerClassName?: string;
  triggerContent: ReactNode;
  /** Accessible name of the trigger (and of the panel). */
  label: string;
  title?: string;
  popClassName?: string;
  /** "menu" for a list of actions, "dialog" for a panel of settings. */
  role?: "menu" | "dialog";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Put the keyboard inside, on the first thing that can be used.
    pop.current
      ?.querySelector<HTMLElement>("button:not(:disabled), input, select")
      ?.focus();

    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Ours, not the editor's: Esc here must not also drop the selection.
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="tb-pop-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup={role}
        aria-expanded={open}
        title={title ?? label}
        onClick={() => setOpen((o) => !o)}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          ref={pop}
          className={`tb-pop ${popClassName}`}
          role={role}
          aria-label={label}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
