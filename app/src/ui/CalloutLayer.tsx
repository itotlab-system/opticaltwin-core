/**
 * The on-screen figure-callout layer: one SVG covering the viewport, drawn from
 * the same pure layout helpers the exporter uses (`app/src/callouts.ts`), so
 * what is on screen is what lands in the PNG.
 *
 * Positions are applied **imperatively**. Every item subscribes to the anchor
 * store and writes its own SVG attributes, instead of re-rendering through
 * React: an orbit moves every anchor on every frame, and a dozen labels
 * re-rendering at 60 Hz is felt in the drag.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BOX_COLORS, CALLOUT_STYLE, LEADER_COLORS, calloutColors, calloutLayout,
  calloutRect, clampFont, leaderStart, lineBaseline,
} from "../callouts";
import type { AnchorStore } from "../scene/anchors";
import type { FigureCallout } from "../types";

const FONT_STEP = 1;

export default function CalloutLayer({
  callouts,
  store,
  selectedId,
  showHidden = false,
  onSelect,
  onChange,
  onDelete,
  onPickAnchor,
}: {
  callouts: FigureCallout[];
  store: AnchorStore;
  selectedId: string | null;
  /** In 図注 mode individually-hidden labels are shown ghosted, so they can be
      brought back; everywhere else (and in every export) they are simply gone. */
  showHidden?: boolean;
  onSelect: (id: string | null) => void;
  onChange: (callout: FigureCallout) => void;
  onDelete: (id: string) => void;
  /** Screen point -> a point on the target part, in the part's own frame. */
  onPickAnchor: (
    clientX: number,
    clientY: number,
    target: string,
  ) => [number, number, number] | null;
}) {
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // A callout deleted while its editor was open must not leave the textarea up.
  useEffect(() => {
    if (editingId && !callouts.some((c) => c.id === editingId)) setEditingId(null);
  }, [callouts, editingId]);

  return (
    <div className="callout-layer">
      <svg className="callout-svg">
        {callouts.filter((c) => showHidden || !c.hidden).map((callout) => (
          <CalloutItem
            key={callout.id}
            callout={callout}
            store={store}
            selected={selectedId === callout.id}
            editing={editingId === callout.id}
            editorHost={editorHost}
            onSelect={onSelect}
            onEdit={setEditingId}
            onChange={onChange}
            onDelete={onDelete}
            onPickAnchor={onPickAnchor}
          />
        ))}
      </svg>
      <div className="callout-editor-host" ref={setEditorHost} />
    </div>
  );
}

function CalloutItem({
  callout, store, selected, editing, editorHost,
  onSelect, onEdit, onChange, onDelete, onPickAnchor,
}: {
  callout: FigureCallout;
  store: AnchorStore;
  selected: boolean;
  editing: boolean;
  editorHost: HTMLDivElement | null;
  onSelect: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onChange: (callout: FigureCallout) => void;
  onDelete: (id: string) => void;
  onPickAnchor: (
    clientX: number,
    clientY: number,
    target: string,
  ) => [number, number, number] | null;
}) {
  const group = useRef<SVGGElement | null>(null);
  const line = useRef<SVGLineElement | null>(null);
  const dot = useRef<SVGCircleElement | null>(null);
  const box = useRef<SVGRectElement | null>(null);
  const hit = useRef<SVGRectElement | null>(null);
  const texts = useRef<(SVGTextElement | null)[]>([]);
  const grip = useRef<SVGCircleElement | null>(null);
  const tools = useRef<SVGGElement | null>(null);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const palette = useRef<HTMLDivElement | null>(null);
  // Live drag offset, on top of the saved dx/dy. A ref, not state, because the
  // redraw it feeds is imperative.
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // Where the anchor dot is being dragged to, in layer pixels. While it is set
  // it overrides the projected anchor, so the dot follows the cursor without a
  // React round-trip; the 3D point is resolved once, on release.
  const anchorDrag = useRef<{ x: number; y: number } | null>(null);
  const [text, setText] = useState(callout.text);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => { setText(callout.text); }, [callout.text]);
  // The swatches belong to the selected label; deselecting has to take them
  // away, or they float over a label that is no longer being styled.
  useEffect(() => { if (!selected) setPaletteOpen(false); }, [selected]);

  const layout = calloutLayout({ ...callout, text });

  useEffect(() => {
    const draw = () => {
      const anchor = anchorDrag.current
        ? { ...anchorDrag.current, behind: false }
        : store.points[callout.id];
      const g = group.current;
      if (!g) return;
      if (!anchor || anchor.behind) {
        g.style.display = "none";
        if (editor.current) editor.current.style.display = "none";
        if (palette.current) palette.current.style.display = "none";
        return;
      }
      g.style.display = "";
      const offset = drag.current ?? { dx: 0, dy: 0 };
      const placed = {
        ...callout,
        text,
        dx: callout.dx + offset.dx,
        dy: callout.dy + offset.dy,
      };
      const rect = calloutRect(anchor, placed, layout);
      const start = leaderStart(rect, anchor);

      line.current?.setAttribute("x1", String(start.x));
      line.current?.setAttribute("y1", String(start.y));
      line.current?.setAttribute("x2", String(anchor.x));
      line.current?.setAttribute("y2", String(anchor.y));
      dot.current?.setAttribute("cx", String(anchor.x));
      dot.current?.setAttribute("cy", String(anchor.y));
      grip.current?.setAttribute("cx", String(anchor.x));
      grip.current?.setAttribute("cy", String(anchor.y));
      for (const rectEl of [box.current, hit.current]) {
        rectEl?.setAttribute("x", String(rect.x));
        rectEl?.setAttribute("y", String(rect.y));
        rectEl?.setAttribute("width", String(rect.width));
        rectEl?.setAttribute("height", String(rect.height));
      }
      texts.current.forEach((el, i) => {
        el?.setAttribute("x", String(rect.x + CALLOUT_STYLE.padX));
        el?.setAttribute("y", String(lineBaseline(rect, layout, i)));
      });
      tools.current?.setAttribute(
        "transform",
        `translate(${rect.x + rect.width}, ${rect.y - 8})`,
      );
      if (editor.current) {
        editor.current.style.display = "";
        editor.current.style.left = `${rect.x}px`;
        editor.current.style.top = `${rect.y}px`;
        editor.current.style.width = `${rect.width}px`;
        editor.current.style.height = `${rect.height}px`;
        editor.current.style.fontSize = `${layout.fontPx}px`;
      }
      if (palette.current) {
        palette.current.style.display = "";
        palette.current.style.left = `${rect.x}px`;
        palette.current.style.top = `${rect.y + rect.height + 8}px`;
      }
    };
    draw();
    return store.subscribe(draw);
  }, [store, callout, layout, text]);

  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);

  function startDrag(e: React.PointerEvent) {
    if (editing) return;
    e.stopPropagation();
    onSelect(callout.id);
    const origin = { x: e.clientX, y: e.clientY };
    const target = e.currentTarget as SVGRectElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      drag.current = { dx: ev.clientX - origin.x, dy: ev.clientY - origin.y };
      store.emit();
    };
    const end = (ev: PointerEvent) => {
      target.releasePointerCapture?.(ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      const moved = drag.current;
      drag.current = null;
      if (moved && (moved.dx || moved.dy)) {
        onChange({ ...callout, dx: callout.dx + moved.dx, dy: callout.dy + moved.dy });
      } else {
        store.emit();
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  }

  // Drag the dot the leader line lands on. The point is resolved against the
  // part's geometry (see Viewport.pickAnchor) and stored in the part's own
  // frame, so a dot put on a lens face stays on that face when the bench moves.
  function startAnchorDrag(e: React.PointerEvent) {
    e.stopPropagation();
    const handle = e.currentTarget as SVGCircleElement;
    const svg = handle.ownerSVGElement;
    handle.setPointerCapture(e.pointerId);
    // Where the dot started, so the box can be held still while it moves: dx/dy
    // are measured *from* the anchor, so without this the label would slide
    // across the picture — and off the edge of it — every time the line was
    // re-aimed, undoing the placement the user had already settled on.
    const from = store.points[callout.id];

    const toLayer = (ev: { clientX: number; clientY: number }) => {
      const rect = svg?.getBoundingClientRect();
      return rect
        ? { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
        : { x: ev.clientX, y: ev.clientY };
    };

    const move = (ev: PointerEvent) => {
      anchorDrag.current = toLayer(ev);
      store.emit();
    };
    const end = (ev: PointerEvent) => {
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      const dragged = anchorDrag.current;
      anchorDrag.current = null;
      if (!dragged) { store.emit(); return; }
      const local = onPickAnchor(ev.clientX, ev.clientY, callout.target);
      if (!local) { store.emit(); return; }   // nothing under the cursor
      onChange({
        ...callout,
        ax: local[0], ay: local[1], az: local[2],
        dx: callout.dx - (from ? dragged.x - from.x : 0),
        dy: callout.dy - (from ? dragged.y - from.y : 0),
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
  }

  function commit() {
    onEdit(null);
    const next = text.trim();
    if (next !== callout.text) onChange({ ...callout, text: next });
  }

  function resize(delta: number) {
    onChange({
      ...callout,
      fontPx: clampFont((callout.fontPx ?? layout.fontPx) + delta),
    });
  }

  const S = CALLOUT_STYLE;
  const C = calloutColors(callout);
  return (
    <g
      ref={group}
      // A hidden label is only on screen at all in 図注 mode, where it is drawn
      // faint so it reads as "not in the figure" without disappearing entirely —
      // it still has to be clickable to be brought back.
      className={`callout-item${callout.hidden ? " hidden" : ""}`}
    >
      <line
        ref={line}
        stroke={C.leader}
        strokeWidth={S.leaderWidth}
        strokeLinecap="round"
        strokeDasharray={callout.hidden ? "4 3" : undefined}
      />
      <circle ref={dot} r={S.dotRadius} fill={C.dotFill} stroke={C.leader} strokeWidth={S.leaderWidth} />
      <rect
        ref={box}
        rx={S.radius}
        fill={C.boxFill}
        // A CSS variable can't be a presentation attribute's value, so the
        // selection colour has to come through `style`.
        style={{ stroke: selected ? "var(--accent)" : C.boxStroke }}
        strokeWidth={selected ? 1.6 : 1}
      />
      {layout.lines.map((content, i) => (
        <text
          key={i}
          ref={(el) => { texts.current[i] = el; }}
          fontFamily={S.fontFamily}
          fontSize={layout.fontPx}
          fill={C.text}
          opacity={editing ? 0 : 1}
        >
          {content}
        </text>
      ))}
      {/* Transparent grab area on top of the box, so the whole label drags. */}
      <rect
        ref={hit}
        className="callout-hit"
        fill="transparent"
        onPointerDown={startDrag}
        onDoubleClick={(e) => { e.stopPropagation(); onEdit(callout.id); }}
      />
      {/* Grab area for the anchor dot, offered once the label is selected so
          it doesn't sit over the parts the rest of the time. */}
      {selected && (
        <circle
          ref={grip}
          className="callout-grip"
          r={10}
          onPointerDown={startAnchorDrag}
        />
      )}
      {selected && !editing && (
        <g ref={tools} className="callout-tools">
          <CalloutButton x={-98} label="A−" onClick={() => resize(-FONT_STEP)} />
          <CalloutButton x={-78} label="A+" onClick={() => resize(FONT_STEP)} />
          <CalloutButton
            x={-58}
            label="色"
            active={paletteOpen}
            onClick={() => setPaletteOpen((v) => !v)}
          />
          {/* Hide, not delete: a label taken out of one figure is usually
              wanted back in the next one, and retyping the text is the part
              that costs. The glyph shows what the click will do. */}
          <CalloutButton
            x={-38}
            label={callout.hidden ? "表" : "隠"}
            onClick={() => onChange({ ...callout, hidden: !callout.hidden })}
          />
          <CalloutButton x={-18} label="✕" onClick={() => onDelete(callout.id)} />
        </g>
      )}
      {selected && !editing && paletteOpen && editorHost && createPortal(
        <div
          ref={palette}
          className="callout-palette"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <SwatchRow
            title="線"
            colors={LEADER_COLORS}
            value={callout.lineColor ?? CALLOUT_STYLE.leader}
            onPick={(value) => onChange({ ...callout, lineColor: value })}
          />
          <SwatchRow
            title="ボックス"
            colors={BOX_COLORS}
            value={callout.boxColor ?? CALLOUT_STYLE.boxFill}
            onPick={(value) => onChange({ ...callout, boxColor: value })}
          />
        </div>,
        editorHost,
      )}
      {editing && editorHost && createPortal(
        <textarea
          ref={editor}
          className="callout-editor"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();        // the viewport's shortcuts are not typing
            if (e.key === "Escape") { setText(callout.text); onEdit(null); }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
          }}
        />,
        editorHost,
      )}
    </g>
  );
}

/** A small square button drawn in SVG so it rides along with the label. */
function CalloutButton({ x, label, active, onClick }: {
  x: number; label: string; active?: boolean; onClick: () => void;
}) {
  return (
    <g
      className={`callout-button${active ? " active" : ""}`}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onClick(); }}
    >
      <rect x={x} y={-8} width={18} height={18} rx={3} />
      <text x={x + 9} y={4} textAnchor="middle" fontSize={11}>{label}</text>
    </g>
  );
}

/**
 * One row of colour swatches. Plain HTML rather than SVG: it is editing
 * furniture, never part of the exported picture, and a `<button>` gets keyboard
 * focus and a title tooltip for free.
 */
function SwatchRow({ title, colors, value, onPick }: {
  title: string;
  colors: { value: string; label: string }[];
  value: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="callout-swatches">
      <span className="callout-swatch-title">{title}</span>
      {colors.map((color) => (
        <button
          key={color.value}
          type="button"
          className={
            `callout-swatch${color.value === "none" ? " none" : ""}`
            + (color.value === value ? " on" : "")
          }
          style={color.value === "none" ? undefined : { background: color.value }}
          title={color.label}
          aria-label={`${title}: ${color.label}`}
          onClick={() => onPick(color.value)}
        />
      ))}
    </div>
  );
}
