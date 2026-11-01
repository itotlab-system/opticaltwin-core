// Photo <-> board mapping, from four holes the user clicked.
//
// The breadboard is a plane with holes on a known 25 mm grid, so four photo
// points with known board positions fix a projective map (a homography)
// between the photo and the board, at any camera angle and with no camera
// calibration. It is exact ON the board plane only: anything above it -- a
// lens on a post -- is displaced by parallax, which is why parts are marked
// at their FOOT, where they meet the board.

export type Point = [number, number];
/** 3x3 row-major. */
export type Homography = number[];

/** Solve A·x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** The homography taking each `from[i]` to `to[i]` (exactly four pairs). */
export function homography(from: Point[], to: Point[]): Homography | null {
  if (from.length !== 4 || to.length !== 4) return null;
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(a, b);
  return h ? [...h, 1] : null;
}

export function apply(h: Homography, [x, y]: Point): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** One calibration click: a photo pixel and the hole (1-based column/row) it is. */
export interface CalibPoint { px: number; py: number; col: number; row: number }

/** The board's hole grid as sorted column X and row Y positions (mm). */
export function holeAxes(holes: [number, number][]): { xs: number[]; ys: number[] } {
  const round = (v: number) => Math.round(v * 10) / 10;
  const xs = [...new Set(holes.map((h) => round(h[0])))].sort((p, q) => p - q);
  const ys = [...new Set(holes.map((h) => round(h[1])))].sort((p, q) => p - q);
  return { xs, ys };
}

/** Default calibration holes: the four corners, in clicking order. */
export function cornerHoles(cols: number, rows: number): { col: number; row: number }[] {
  return [
    { col: 1, row: 1 },        // near left   (-X, -Y)
    { col: cols, row: 1 },     // near right  (+X, -Y)
    { col: cols, row: rows },  // far right   (+X, +Y)
    { col: 1, row: rows },     // far left    (-X, +Y)
  ];
}

/** Photo -> board and board -> photo maps, or null until four holes are set. */
export function calibrate(
  points: CalibPoint[], axes: { xs: number[]; ys: number[] },
): { toBoard: Homography; toPhoto: Homography } | null {
  if (points.length !== 4) return null;
  const board: Point[] = [];
  for (const p of points) {
    const x = axes.xs[p.col - 1];
    const y = axes.ys[p.row - 1];
    if (x === undefined || y === undefined) return null;
    board.push([x, y]);
  }
  const photo: Point[] = points.map((p) => [p.px, p.py]);
  const toBoard = homography(photo, board);
  const toPhoto = homography(board, photo);
  return toBoard && toPhoto ? { toBoard, toPhoto } : null;
}

/** Holes within this distance of a marked foot capture it (mm). */
export const HOLE_SNAP_MM = 6;

/** The nearest hole if within HOLE_SNAP_MM, else the point as marked. */
export function snapToHole(p: Point, holes: [number, number][]): { p: Point; snapped: boolean } {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const h of holes) {
    const d = Math.hypot(h[0] - p[0], h[1] - p[1]);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best && bestD <= HOLE_SNAP_MM ? { p: [best[0], best[1]], snapped: true } : { p, snapped: false };
}

/**
 * Which board corner each of four clicked holes is, from where they sit.
 *
 * The usual bench photo is taken from the near side, so the near edge is the
 * lower pair in the photo: lower-left is (-X, -Y), lower-right (+X, -Y), and
 * the upper pair the far corners. Clicks can then come in any order. `turn`
 * rotates the assignment a quarter at a time, for a photo taken from another
 * side of the table.
 */
export function assignCorners(
  points: CalibPoint[], axes: { xs: number[]; ys: number[] }, turn = 0,
): CalibPoint[] {
  if (points.length !== 4) return points;
  const byY = points.map((p, i) => ({ p, i })).sort((a, b) => b.p.py - a.p.py);
  const near = byY.slice(0, 2).sort((a, b) => a.p.px - b.p.px);
  const far = byY.slice(2).sort((a, b) => a.p.px - b.p.px);
  // Positions in the photo, going round: near-left, near-right, far-right, far-left.
  const around = [near[0], near[1], far[1], far[0]];
  const corners = cornerHoles(axes.xs.length, axes.ys.length);
  const out = [...points];
  around.forEach(({ i }, k) => {
    out[i] = { ...points[i], ...corners[(k + turn) % 4] };
  });
  return out;
}

/** Which corner (0..3, as in cornerHoles) a calibration point is, or -1. */
export function cornerIndex(p: CalibPoint, axes: { xs: number[]; ys: number[] }): number {
  return cornerHoles(axes.xs.length, axes.ys.length)
    .findIndex((c) => c.col === p.col && c.row === p.row);
}

const FOLDS = new Set(["mirror", "beamsplitter"]);
const GRID_SNAP_DEG = 10;

/**
 * A hand-drawn direction, squared to the hole grid when it is close.
 *
 * Benches are built square to the board, and an arrow dragged on a photo is
 * never exactly straight: a laser 3° off would tilt every part after it. So a
 * direction within 10° of a multiple of 45° is taken to be that multiple.
 */
export function squareToGrid(v: Point): Point {
  const deg = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  const nearest = Math.round(deg / 45) * 45;
  const use = Math.abs(deg - nearest) <= GRID_SNAP_DEG ? nearest : deg;
  const r = (use * Math.PI) / 180;
  return [Math.round(Math.cos(r) * 1e9) / 1e9, Math.round(Math.sin(r) * 1e9) / 1e9];
}

/**
 * A drawn path, squared to the hole grid leg by leg.
 *
 * The first point stays where it was clicked; each next point is moved onto
 * the squared direction from the one before (see squareToGrid), keeping how
 * far along it went. So a hand-drawn polyline comes out with clean 90° (or
 * 45°) bends that the built beam can actually follow.
 */
export function squarePath(points: Point[]): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const v: Point = [points[i][0] - prev[0], points[i][1] - prev[1]];
    if (Math.hypot(v[0], v[1]) < 1e-6) continue;
    const d = squareToGrid(v);
    const len = Math.max(0, v[0] * d[0] + v[1] * d[1]);
    out.push([prev[0] + d[0] * len, prev[1] + d[1] * len]);
  }
  return out;
}

export interface DraftSeg { a: Point; b: Point; d: Point }
/** A corner of the draft: where the beam has to be turned. */
export interface DraftTurn {
  at: Point;
  inDir: Point;
  outDir: Point;
  /** A branch leaves here while the beam also goes straight on: a splitter. */
  split: boolean;
  /** No single part can do this: a splitter at a corner reflects one way and
   *  transmits STRAIGHT on, so the branch has to carry on straight. */
  impossible?: boolean;
}
export interface Draft {
  paths: Point[][];          // squared, board mm; paths[0] starts at the laser
  segs: DraftSeg[];
  turns: DraftTurn[];
  start: Point | null;
  startDir: Point | null;
}

/** Branch starts within this of an existing corner join it (mm). */
export const BRANCH_JOIN_MM = 30;
const unit = (v: Point): Point => {
  const n = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / n, v[1] / n];
};
const close = (a: Point, b: Point, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

/**
 * The drafted beam: the main path from the laser, plus branches that start
 * at a point of an earlier path (a beamsplitter's second arm).
 */
export function buildDraft(rawPaths: Point[][]): Draft {
  const paths: Point[][] = [];
  const segs: DraftSeg[] = [];
  const turns: DraftTurn[] = [];
  const pendingBranches: { at: Point; dir: Point }[] = [];
  for (const raw of rawPaths) {
    if (raw.length === 0) continue;
    let pts = raw;
    let from: DraftSeg | null = null;
    if (paths.length > 0) {
      // A branch begins exactly ON the beam drawn so far -- usually partway
      // along a straight leg, where a splitter sits.
      const hit = nearestOnSegs(raw[0], segs);
      if (hit && hit.dist <= BRANCH_JOIN_MM) {
        // Near a corner of the beam: it starts ON the corner, so the corner
        // and the branch are one part (a splitter), not two side by side.
        const corner = paths.flat().find((q) => close(q, hit.at, TURN_SNAP_MM));
        pts = [corner ?? hit.at, ...raw.slice(1)];
        from = corner
          ? segs.find((sg) => close(sg.b, corner, 1e-6)) ?? hit.seg
          : hit.seg;
      }
    }
    const sq = squarePath(pts);
    paths.push(sq);
    if (from && sq.length > 1) {
      const outDir = unit([sq[1][0] - sq[0][0], sq[1][1] - sq[0][1]]);
      const existing = turns.find((t) => close(t.at, sq[0], 1e-6));
      // Already a bend here: still one splitter, reflecting one way and
      // transmitting the other.
      if (existing) existing.split = true;
      else turns.push({ at: sq[0], inDir: from.d, outDir, split: true });
      pendingBranches.push({ at: sq[0], dir: outDir });
    }
    for (let i = 0; i + 1 < sq.length; i++) {
      segs.push({ a: sq[i], b: sq[i + 1], d: unit([sq[i + 1][0] - sq[i][0], sq[i + 1][1] - sq[i][1]]) });
    }
  }
  // Bends inside each path.
  for (const path of paths) {
    for (let i = 1; i + 1 < path.length; i++) {
      const inDir = unit([path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]]);
      const outDir = unit([path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]]);
      if (inDir[0] * outDir[0] + inDir[1] * outDir[1] < 0.999) {
        const existing = turns.find((t) => close(t.at, path[i], 1e-6));
        if (existing) { existing.inDir = inDir; existing.outDir = outDir; }
        else turns.push({ at: path[i], inDir, outDir, split: false });
      }
    }
  }
  // A branch leaving a corner must go straight on (the splitter's
  // transmitted arm); anything else needs more than one part.
  for (const b of pendingBranches) {
    const turn = turns.find((t) => close(t.at, b.at, 1e-6));
    if (!turn || turn.outDir === b.dir) continue;
    const straight = turn.inDir[0] * b.dir[0] + turn.inDir[1] * b.dir[1] > 0.999;
    const sameAsBend = turn.outDir[0] * b.dir[0] + turn.outDir[1] * b.dir[1] > 0.999;
    if (!straight && !sameAsBend) turn.impossible = true;
  }
  const main = paths[0];
  return {
    paths, segs, turns,
    start: main ? main[0] : null,
    startDir: main && main.length > 1 ? unit([main[1][0] - main[0][0], main[1][1] - main[0][1]]) : null,
  };
}

function nearestOnSegs(
  p: Point, segs: DraftSeg[],
): { at: Point; dist: number; seg: DraftSeg } | null {
  let best: { at: Point; dist: number; seg: DraftSeg } | null = null;
  for (const s of segs) {
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const t = Math.max(0, Math.min(len, (p[0] - s.a[0]) * s.d[0] + (p[1] - s.a[1]) * s.d[1]));
    const at: Point = [s.a[0] + s.d[0] * t, s.a[1] + s.d[1] * t];
    const dist = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (!best || dist < best.dist) best = { at, dist, seg: s };
  }
  return best;
}

/** A part further than this from every leg is not on the beam (mm). */
export const ON_DRAFT_MM = 60;
/** A part this close to a corner sits on the corner (mm). */
export const TURN_SNAP_MM = 25;

/**
 * Where a part marked at `foot` goes on the drafted beam, and which way the
 * beam leaves it -- or null when it is nowhere near the beam.
 */
export function placeOnDraft(
  foot: Point, type: string, draft: Draft,
): { at: Point; out: Point; turn: DraftTurn | null } | null {
  if (type === "laser" && draft.start && draft.startDir) {
    return { at: draft.start, out: draft.startDir, turn: null };
  }
  const turn = draft.turns.find((t) => close(t.at, foot, TURN_SNAP_MM)) ?? null;
  if (turn) {
    return { at: turn.at, out: FOLDS.has(type) ? turn.outDir : turn.inDir, turn };
  }
  const hit = nearestOnSegs(foot, draft.segs);
  return hit && hit.dist <= ON_DRAFT_MM ? { at: hit.at, out: hit.seg.d, turn: null } : null;
}
