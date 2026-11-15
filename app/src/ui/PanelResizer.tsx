import { useRef } from "react";

type Props = {
  label: string;
  width: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onResize: (width: number) => void;
};

export default function PanelResizer({ label, width, min, max, direction, onResize }: Props) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onResize(Math.min(max, Math.max(min, value)));

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        if (drag.current) {
          resize(drag.current.width + direction * (event.clientX - drag.current.x));
        }
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          resize(width + direction * (event.key === "ArrowRight" ? 10 : -10));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          event.stopPropagation();
          resize(event.key === "Home" ? min : max);
        }
      }}
    />
  );
}
