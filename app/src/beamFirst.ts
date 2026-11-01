// Beam-first building, client half: where a part being placed will land.
//
// The server decides where a dropped part actually goes (beam_first.py); this
// mirrors it so the placement ghost already stands in the beam, turned the way
// the drop will turn it, before the click. Keep the two in step: same snap
// distance, same in-beam types, same fold angles.

import type { BeamSegment, Component } from "./types";

/** Plan distance (mm) from a beam leg within which a drop lands in the beam. */
export const SNAP_TO_BEAM_MM = 40;

/** Parts that sit in the beam. Hardware and the laser itself never snap. */
export const SNAP_TYPES = new Set([
  "lens", "cylindrical_lens", "eyepiece", "polarizer", "iris", "mirror",
  "beamsplitter", "camera", "detector", "slm", "target",
]);

/** Parts whose fold the arrows set. */
export const FOLD_TYPES = new Set(["mirror", "beamsplitter"]);

export type Turn = "left" | "right";

export interface BeamHit {
  key?: string;
  point: [number, number, number];
  direction: [number, number, number];
}

/** The leg nearest (x, y) in plan, if within `tolerance`, and the point on it. */
export function nearestLeg(
  beam: BeamSegment[], x: number, y: number, tolerance = SNAP_TO_BEAM_MM,
): BeamHit | null {
  let best: (BeamHit & { distance: number }) | null = null;
  for (const leg of beam) {
    const start = leg.pts[0];
    const end = leg.pts[leg.pts.length - 1];
    if (!start || !end) continue;
    const span = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const plan = Math.hypot(span[0], span[1]);
    if (plan < 1e-6) continue;
    const t = Math.max(0, Math.min(1,
      ((x - start[0]) * span[0] + (y - start[1]) * span[1]) / (plan * plan)));
    const point: [number, number, number] = [
      start[0] + t * span[0], start[1] + t * span[1], start[2] + t * span[2],
    ];
    const distance = Math.hypot(x - point[0], y - point[1]);
    if (distance > tolerance || (best && distance >= best.distance)) continue;
    const length = Math.hypot(span[0], span[1], span[2]);
    best = {
      key: leg.key, point, distance,
      direction: [span[0] / length, span[1] / length, span[2] / length],
    };
  }
  if (!best) return null;
  const { distance: _distance, ...hit } = best;
  return hit;
}

/**
 * The leg the pointer is over, judged along the line of sight.
 *
 * A beam floats at beam height, so the board point under the cursor is well
 * behind (or in front of) the beam the user is aiming at — 100 mm up, seen at
 * 45°, is 100 mm off in plan. Measuring from the ray instead snaps to the beam
 * the user actually sees under the cursor.
 */
export function nearestLegToRay(
  beam: BeamSegment[],
  origin: readonly number[],
  dir: readonly number[],
  tolerance = SNAP_TO_BEAM_MM,
): BeamHit | null {
  let best: (BeamHit & { distance: number }) | null = null;
  const dn = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const u = [dir[0] / dn, dir[1] / dn, dir[2] / dn];
  for (const leg of beam) {
    const a = leg.pts[0];
    const b = leg.pts[leg.pts.length - 1];
    if (!a || !b) continue;
    const span = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(span[0], span[1], span[2]);
    if (len < 1e-6 || Math.hypot(span[0], span[1]) < 1e-6) continue;
    const v = [span[0] / len, span[1] / len, span[2] / len];
    // Closest points between the ray (origin + s·u) and the leg (a + t·v).
    const w = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const uw = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
    const vw = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
    const denom = 1 - uv * uv;
    if (denom < 1e-9) continue;   // looking straight down the leg
    let t = (vw - uv * uw) / denom;
    t = Math.max(0, Math.min(len, t));
    const point: [number, number, number] = [a[0] + t * v[0], a[1] + t * v[1], a[2] + t * v[2]];
    const s = Math.max(0, u[0] * (point[0] - origin[0]) + u[1] * (point[1] - origin[1])
      + u[2] * (point[2] - origin[2]));
    const onRay = [origin[0] + s * u[0], origin[1] + s * u[1], origin[2] + s * u[2]];
    const distance = Math.hypot(point[0] - onRay[0], point[1] - onRay[1], point[2] - onRay[2]);
    if (distance > tolerance || (best && distance >= best.distance)) continue;
    best = { key: leg.key, point, distance, direction: [v[0], v[1], v[2]] as [number, number, number] };
  }
  if (!best) return null;
  const { distance: _distance, ...hit } = best;
  return hit;
}

export function headingDeg(direction: readonly number[]): number {
  return (Math.atan2(direction[1], direction[0]) * 180) / Math.PI;
}

/** rotZ that reflects `incoming` 90° to the `turn` side (see fold_rot_z). */
export function foldRotZ(type: string, incoming: readonly number[], turn: Turn): number {
  const plan = Math.hypot(incoming[0], incoming[1]);
  const d = [incoming[0] / plan, incoming[1] / plan];
  const sign = turn === "left" ? 1 : -1;
  const out = [-sign * d[1], sign * d[0]];
  const normal = (Math.atan2(out[1] - d[1], out[0] - d[0]) * 180) / Math.PI;
  return type === "beamsplitter" ? normal - 45 : normal;
}

/**
 * Where a part dropped at (x, y) would land: in the beam if it is an in-beam
 * part near one, otherwise null (it lands where it was dropped, as before).
 */
export function snapPlacement(
  part: Pick<Component, "type" | "attrs">,
  beam: BeamSegment[],
  x: number,
  y: number,
  ray?: { origin: readonly number[]; direction: readonly number[] },
): { x: number; y: number; z: number; rotZ: number; key?: string;
  beamX: number; beamY: number } | null {
  if (!SNAP_TYPES.has(part.type)) return null;
  const hit = ray
    ? nearestLegToRay(beam, ray.origin, ray.direction) ?? nearestLeg(beam, x, y)
    : nearestLeg(beam, x, y);
  if (!hit) return null;
  const rotZ = FOLD_TYPES.has(part.type)
    ? foldRotZ(part.type, hit.direction, "left")
    : headingDeg(hit.direction);
  // Centre the part's optical centre, not its origin, on the beam — the
  // server does the same through beam_tracer._optical_center.
  const attrs = (part.attrs ?? {}) as Record<string, unknown>;
  const cx = Number(attrs.centerX_mm ?? 0) || 0;
  const cy = Number(attrs.centerY_mm ?? 0) || 0;
  const cz = Number(attrs.centerZ_mm ?? 0) || 0;
  const r = (rotZ * Math.PI) / 180;
  return {
    x: hit.point[0] - (Math.cos(r) * cx - Math.sin(r) * cy),
    y: hit.point[1] - (Math.sin(r) * cx + Math.cos(r) * cy),
    z: hit.point[2] - cz,
    rotZ,
    key: hit.key,
    // The beam point itself: what to send the server as the drop, so its own
    // plan-distance snap finds the same leg at distance zero.
    beamX: hit.point[0],
    beamY: hit.point[1],
  };
}
