// How a beam leg is drawn. Kept pure so it can be reasoned about without a
// canvas: the 3D viewport is the only consumer.
//
// This is a planning sketch, not a simulation. You pick one width for a leg
// and a shape, and the two ends follow from that — no separate in/out numbers
// to reconcile, and editing one leg never disturbs another.
import type { BeamSegment, Component, ComponentUpdate } from "./types";

/** The drawn profile of one leg. Widths are full widths in mm. */
export interface SegmentShape {
  wIn: number;
  wOut: number;
  /** Fraction along the leg where it pinches, for a focus. */
  waistAt?: number;
  waistW?: number;
  /** How far the beam is drawn along the leg. Absent = the whole gap. */
  lengthMm?: number;
}

// The shortest an escaping ray is drawn. The tracer runs it to 10 m, which
// would bury the bench in a solid tube, so it stops at the board's edge
// instead (see openEndReach) — and never shorter than this, so a ray leaving
// a part near the edge still shows which way it goes.
export const OPEN_END_DRAW_MM = 220;

/** The part of the board a beam is drawn across: its plan rectangle. */
export type BoardBounds = { min: readonly number[]; max: readonly number[] } | null | undefined;

export const DEFAULT_BEAM_WIDTH_MM = 6;

/** How much a wedge opens or closes over the leg. */
const TAPER = 2.5;

export type ShapeId = "parallel" | "expanding" | "converging" | "focus";

/**
 * The shapes a leg can be given. Each takes the leg's single width and decides
 * both ends from it, so the user sets one number rather than two.
 */
export const SHAPE_PRESETS: Array<{
  id: ShapeId;
  glyph: string;
  label: string;
  hint: string;
  apply: (widthMm: number) => SegmentShape;
}> = [
  {
    id: "parallel", glyph: "▭", label: "Parallel",
    hint: "Same width the whole way — a collimated stretch",
    apply: (w) => ({ wIn: w, wOut: w }),
  },
  {
    id: "expanding", glyph: "◁", label: "Expand",
    hint: "Starts narrow and opens out",
    apply: (w) => ({ wIn: w / TAPER, wOut: w }),
  },
  {
    id: "converging", glyph: "▷", label: "Shrink",
    hint: "Starts wide and closes down",
    apply: (w) => ({ wIn: w, wOut: w / TAPER }),
  },
  {
    id: "focus", glyph: "▷◁", label: "Focus",
    hint: "Pinches to a point in the middle, then opens out again",
    apply: (w) => ({
      wIn: w, wOut: w, waistAt: 0.5, waistW: Math.max(w / 8, 0.15),
    }),
  },
];

export function shapeOf(seg: BeamSegment): SegmentShape {
  return {
    wIn: seg.wIn ?? DEFAULT_BEAM_WIDTH_MM,
    wOut: seg.wOut ?? DEFAULT_BEAM_WIDTH_MM,
    waistAt: seg.waistAt,
    waistW: seg.waistW,
    lengthMm: seg.lengthMm,
  };
}

/**
 * How long the leg is before anyone sketches on it: the real gap between the
 * two parts, or a readable stub for a ray that escapes (the tracer runs those
 * to 10 m).
 *
 * Independent of `lengthMm` on purpose — it is what the editor anchors and
 * scales itself against, so dragging the length doesn't move the goalposts.
 */
export function naturalLengthOf(seg: BeamSegment, board?: BoardBounds): number {
  const geometric = segmentLength(seg);
  if (seg.to) return geometric;
  return Math.min(geometric, Math.max(OPEN_END_DRAW_MM, openEndReach(seg, board)));
}

/**
 * How far an escaping ray runs before it leaves the board, in plan.
 *
 * Building beam-first, the open beam is where the next part goes: drawing it
 * all the way across the board shows the whole line it can be dropped on,
 * where a fixed short stub ended in mid-air a few holes out of the laser.
 * 0 when there is no board, or the ray starts off it.
 */
export function openEndReach(seg: BeamSegment, board?: BoardBounds): number {
  if (!board || seg.pts.length < 2) return 0;
  const [a, b] = [seg.pts[0], seg.pts[seg.pts.length - 1]];
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  if (length < 1e-9) return 0;
  let reach = Infinity;
  for (const axis of [0, 1]) {
    const v = d[axis] / length;
    if (a[axis] < board.min[axis] || a[axis] > board.max[axis]) return 0;
    if (Math.abs(v) < 1e-9) continue;
    const edge = v > 0 ? board.max[axis] : board.min[axis];
    reach = Math.min(reach, (edge - a[axis]) / v);
  }
  return Number.isFinite(reach) ? reach : 0;
}

/**
 * How far the beam is drawn along a leg.
 *
 * Defaults to the natural length. Overriding it only changes the drawing — the
 * optic at the far end stays exactly where it is.
 */
export function drawnLengthOf(seg: BeamSegment, board?: BoardBounds): number {
  if (seg.lengthMm !== undefined) return seg.lengthMm;
  return naturalLengthOf(seg, board);
}

/** Which shape a leg is currently drawn as. */
export function shapeIdOf(shape: SegmentShape): ShapeId {
  if (shape.waistW !== undefined) return "focus";
  const ratio = shape.wOut / (shape.wIn || 1);
  if (Math.abs(ratio - 1) < 0.02) return "parallel";
  return ratio > 1 ? "expanding" : "converging";
}

/**
 * The one width the user edits: the leg's widest point, which is the end that
 * carries the meaning for every shape. Re-applying a preset to this value
 * round-trips, so switching shapes back and forth doesn't drift.
 */
export function widthOf(shape: SegmentShape): number {
  return Math.max(shape.wIn, shape.wOut);
}

/** Re-draw a leg at a new width, keeping whatever shape it already has. */
export function withWidth(shape: SegmentShape, widthMm: number): SegmentShape {
  const preset = SHAPE_PRESETS.find((p) => p.id === shapeIdOf(shape));
  return (preset ?? SHAPE_PRESETS[0]).apply(widthMm);
}

/** Along-beam length of a leg in mm. */
export function segmentLength(seg: BeamSegment): number {
  const [a, b] = seg.pts;
  if (!a || !b) return 0;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}
