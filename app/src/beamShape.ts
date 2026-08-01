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

// How far an escaping ray is drawn before it stops. The tracer runs it to 10 m,
// which would bury the bench in a solid tube.
export const OPEN_END_DRAW_MM = 220;

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
export function naturalLengthOf(seg: BeamSegment): number {
  const geometric = segmentLength(seg);
  return seg.to ? geometric : Math.min(geometric, OPEN_END_DRAW_MM);
}

/**
 * How far the beam is drawn along a leg.
 *
 * Defaults to the natural length. Overriding it only changes the drawing — the
 * optic at the far end stays exactly where it is.
 */
export function drawnLengthOf(seg: BeamSegment): number {
  if (seg.lengthMm !== undefined) return seg.lengthMm;
  return naturalLengthOf(seg);
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
