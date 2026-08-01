import { useEffect, useRef, useState } from "react";
import type { BeamSegment } from "../types";
import {
  SHAPE_PRESETS, drawnLengthOf, naturalLengthOf, shapeIdOf, shapeOf, widthOf,
  type SegmentShape,
} from "../beamShape";
import SweepSlider from "./SweepSlider";

const round = (v: number) => Math.round(v * 10) / 10;

/** Widest a bar reaches by default — an inch optic, so the whole clear aperture. */
const MAX_WIDTH_MM = 25.4;

/**
 * The editor for one beam leg, floating beside the leg in the 3D viewport.
 *
 * Drag its header to move it off whatever it is covering — it is anchored to a
 * point in the scene, so on a crowded bench it will otherwise sit over the
 * optics you are trying to look at. The offset is per-selection: picking a
 * different leg starts it beside that leg again.
 */
export default function SegmentPopover({
  segment, onShape, onClose,
}: {
  segment: BeamSegment;
  onShape: (shape: SegmentShape) => void;
  onClose: () => void;
}) {
  const shape = shapeOf(segment);
  // How far the beam is *drawn*. Editing it re-draws this leg and nothing
  // else — it never slides the optic at the far end down the bench.
  const length = drawnLengthOf(segment);
  const active = shapeIdOf(shape);

  // The Length bar reaches well past the leg's own gap. Stopping at the gap
  // (192 mm on a short hop between cage plates) left no way to sketch a beam
  // carrying on past the next optic, which is half of what the control is for.
  // A whole 600 mm board is always in reach; a long leg gets 3× its own gap.
  const maxLength = Math.max(Math.ceil(naturalLengthOf(segment) * 3 / 50) * 50, 600);

  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  // A fresh selection puts the card back beside its own leg.
  useEffect(() => setDrag({ x: 0, y: 0 }), [segment.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function startDrag(e: React.PointerEvent) {
    // Let the close button and the inputs keep their own behaviour.
    if ((e.target as HTMLElement).closest("button, input")) return;
    e.stopPropagation();
    dragFrom.current = { x: e.clientX - drag.x, y: e.clientY - drag.y };
    const onMove = (move: PointerEvent) => {
      const from = dragFrom.current;
      if (!from) return;
      setDrag({ x: move.clientX - from.x, y: move.clientY - from.y });
    };
    const onUp = () => {
      dragFrom.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function setEndWidth(field: "wIn" | "wOut", value: number) {
    if (value <= 0) return;
    // Setting one end by hand means a straight-sided leg, not a focus.
    onShape({ ...shape, [field]: value, waistAt: undefined, waistW: undefined });
  }

  return (
    <div
      className="segment-popover"
      style={{ transform: `translate(${16 + drag.x}px, calc(-50% + ${drag.y}px))` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="sp-head" onPointerDown={startDrag}>
        <span className="sp-grip" aria-hidden="true">⠿</span>
        <span className="sp-route">
          {segment.from ?? "source"} <span className="sp-arrow">→</span>{" "}
          {segment.to ?? "open end"}
        </span>
        <button className="sp-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="sp-fields">
        <SweepSlider
          label="Length"
          title="How far the beam is drawn along this stretch. Nothing moves."
          value={round(length)}
          min={0} max={maxLength} step={0.1}
          onChange={(v) => onShape({ ...shape, lengthMm: v })}
        />
        <SweepSlider
          label="Width in"
          title="Beam width where it enters this stretch"
          value={round(shape.wIn)}
          min={0.1} max={MAX_WIDTH_MM} step={0.1}
          onChange={(v) => setEndWidth("wIn", v)}
        />
        <SweepSlider
          label="Width out"
          title="Beam width where it leaves this stretch"
          value={round(shape.wOut)}
          min={0.1} max={MAX_WIDTH_MM} step={0.1}
          onChange={(v) => setEndWidth("wOut", v)}
        />
      </div>

      <div className="sp-shapes">
        {SHAPE_PRESETS.map((p) => (
          <button
            key={p.id}
            className={active === p.id ? "active" : ""}
            title={p.hint}
            onClick={() => onShape({ ...p.apply(widthOf(shape)), lengthMm: shape.lengthMm })}
          >
            <span className="sp-glyph">{p.glyph}</span>
            <span className="sp-preset-label">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
