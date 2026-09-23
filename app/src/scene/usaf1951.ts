import * as THREE from "three";

// The USAF 1951 resolution chart, drawn procedurally at true physical scale.
//
// None of our target CAD carries the chart: the R3L3S1N STEP is the bare glass
// envelope (twelve triangles, one colour) and the R1L1S7N/P carry only a flat
// dark rectangle where the chart should be. The assets do author
// `optics:pattern = "USAF1951"` and `optics:polarity`, so the chart is drawn
// here from those two attributes instead of being modelled.
//
// This is a drawing, not a measurement aid: bar sizes follow the standard so
// the pattern occupies the right area of the substrate, but the finest groups
// are microns wide and simply cannot survive rasterisation (see MIN_BAR_PX).

const GROUP_MIN = -2;
const GROUP_MAX = 7;
const ELEMENTS = [1, 2, 3, 4, 5, 6];

// Bars are five times as long as they are wide, three to a block, separated by
// one bar width — so a block is a square of side 5w either way round.
const BAR_ASPECT = 5;
const BLOCK_GAP = 1.0; // in bar widths, between the two blocks of an element
const ROW_GAP = 1.0; // in bar widths, between elements down a column

const CANVAS_PX = 2048;
// Below this a bar is thinner than the rasteriser can resolve and would smear
// the block into a flat gray. Real charts behave the same way to the naked eye.
const MIN_BAR_PX = 0.6;

/** Line pairs per millimetre — the USAF 1951 definition. */
export function lpPerMm(group: number, element: number): number {
  return Math.pow(2, group + (element - 1) / 6);
}

/** Width of a single bar, in mm. */
export function barWidthMm(group: number, element: number): number {
  return 1 / (2 * lpPerMm(group, element));
}

/** Width of one group's column: two blocks of its largest element, plus a gap. */
function columnWidthMm(group: number): number {
  const w = barWidthMm(group, 1);
  return (2 * BAR_ASPECT + BLOCK_GAP) * w;
}

/** Height of one group's column: six element blocks, stacked. */
function columnHeightMm(group: number): number {
  let total = 0;
  for (const e of ELEMENTS) {
    const w = barWidthMm(group, e);
    total += BAR_ASPECT * w + ROW_GAP * w;
  }
  return total - ROW_GAP * barWidthMm(group, 6);
}

/**
 * Clear space between a level's two columns, which is where the next pair goes.
 *
 * A pair two groups finer is exactly 4x smaller, so the gap is sized off the
 * child rather than guessed, and the recursion converges in a few levels.
 */
function centreGapMm(group: number): number {
  const col = columnWidthMm(group);
  const inner = group + 2 <= GROUP_MAX ? chartWidthMm(group + 2) : 0;
  return Math.max(inner, col * 0.5) + col * 0.3;
}

/**
 * Width of the whole nested chart rooted at the pair (group, group + 1).
 *
 * The two columns are not the same width: the odd group on the right is one
 * group finer, so exactly half the size of the even one on the left.
 */
function chartWidthMm(group: number): number {
  const right = group + 1 <= GROUP_MAX ? columnWidthMm(group + 1) : 0;
  return columnWidthMm(group) + right + centreGapMm(group);
}

function chartHeightMm(group: number): number {
  return columnHeightMm(group) * 1.25; // room for the group labels above
}

/**
 * The coarsest group pair whose chart still fits the substrate.
 *
 * A 3" target takes the full -2 chart, filling most of the glass; a 1" one has
 * to start finer, exactly as the real parts do.
 */
export function fitStartGroup(sizeMm: number): number {
  const room = sizeMm * 0.94;
  for (let g = GROUP_MIN; g <= GROUP_MAX; g += 2) {
    if (chartWidthMm(g) <= room && chartHeightMm(g) <= room) return g;
  }
  return GROUP_MAX - 1;
}

type DrawContext = {
  ctx: CanvasRenderingContext2D;
  pxPerMm: number;
  originPx: number; // canvas centre, in px
};

/** mm from the chart centre -> canvas px. */
function px(d: DrawContext, mm: number): number {
  return d.originPx + mm * d.pxPerMm;
}

function drawHorizontalBars(d: DrawContext, xMm: number, yMm: number, wMm: number) {
  const len = BAR_ASPECT * wMm;
  for (let i = 0; i < 3; i++) {
    d.ctx.fillRect(
      px(d, xMm),
      px(d, yMm + i * 2 * wMm),
      len * d.pxPerMm,
      wMm * d.pxPerMm,
    );
  }
}

function drawVerticalBars(d: DrawContext, xMm: number, yMm: number, wMm: number) {
  const len = BAR_ASPECT * wMm;
  for (let i = 0; i < 3; i++) {
    d.ctx.fillRect(
      px(d, xMm + i * 2 * wMm),
      px(d, yMm),
      wMm * d.pxPerMm,
      len * d.pxPerMm,
    );
  }
}

function drawLabel(d: DrawContext, text: string, xMm: number, yMm: number, sizeMm: number) {
  const sizePx = sizeMm * d.pxPerMm;
  if (sizePx < 7) return; // unreadable; leave it off rather than draw mush
  d.ctx.font = `${sizePx}px sans-serif`;
  d.ctx.fillText(text, px(d, xMm), px(d, yMm));
}

/**
 * One group's column of six elements.
 *
 * `side` is -1 for the left column (horizontal bars then vertical, numbered on
 * the left) and +1 for the right, which mirrors it — the arrangement on a real
 * chart, and the reason the two columns read as a pair.
 */
function drawColumn(d: DrawContext, group: number, side: -1 | 1, edgeMm: number, topMm: number) {
  const colW = columnWidthMm(group);
  const left = side < 0 ? edgeMm - colW : edgeMm;
  let y = topMm;

  d.ctx.textBaseline = "middle";
  drawLabel(
    d,
    String(group),
    left + colW / 2,
    y - barWidthMm(group, 1) * 2.2,
    barWidthMm(group, 1) * 2.6,
  );

  for (const e of ELEMENTS) {
    const w = barWidthMm(group, e);
    const len = BAR_ASPECT * w;
    if (w * d.pxPerMm >= MIN_BAR_PX) {
      const first = left;
      const second = left + len + BLOCK_GAP * w;
      if (side < 0) {
        drawHorizontalBars(d, first, y, w);
        drawVerticalBars(d, second, y, w);
      } else {
        drawVerticalBars(d, first, y, w);
        drawHorizontalBars(d, second, y, w);
      }
      d.ctx.textAlign = side < 0 ? "right" : "left";
      drawLabel(
        d,
        String(e),
        side < 0 ? left - w * 1.5 : left + colW + w * 1.5,
        y + len / 2,
        w * 2.4,
      );
    }
    y += len + ROW_GAP * w;
  }
}

/** A group pair and, nested between its columns, every finer pair. */
function drawLevel(d: DrawContext, group: number) {
  if (group > GROUP_MAX) return;
  const gap = centreGapMm(group);
  const leftW = columnWidthMm(group);
  const rightW = group + 1 <= GROUP_MAX ? columnWidthMm(group + 1) : 0;
  // The right column is one group finer, so half as wide; nudge the pair over
  // by the difference to keep the level centred on the substrate.
  const shift = (leftW - rightW) / 2;
  // Both columns of a pair hang from the same line, as on a real chart — the
  // finer one on the right simply runs out sooner. Each level is centred on
  // the substrate, so the finer pairs nest in the middle.
  const top = -columnHeightMm(group) / 2;

  d.ctx.textAlign = "center";
  drawColumn(d, group, -1, shift - gap / 2, top);
  if (group + 1 <= GROUP_MAX) {
    d.ctx.textAlign = "center";
    drawColumn(d, group + 1, 1, shift + gap / 2, top);
  }
  drawLevel(d, group + 2);
}

export type Polarity = "negative" | "positive";

/**
 * Draw the chart into a 2D context covering `sizeMm` square.
 *
 * A negative target is opaque chrome with the bars cleared, so the bars are
 * punched out with `destination-out` and the glass slab behind shows through
 * them. A positive one is the inverse: bare alpha with the bars inked.
 */
export function drawUsaf1951(
  ctx: CanvasRenderingContext2D,
  { sizeMm, canvasPx, polarity, ink }: {
    sizeMm: number;
    canvasPx: number;
    polarity: Polarity;
    ink: string;
  },
) {
  const pxPerMm = canvasPx / sizeMm;
  ctx.clearRect(0, 0, canvasPx, canvasPx);
  if (polarity === "negative") {
    ctx.fillStyle = ink;
    ctx.fillRect(0, 0, canvasPx, canvasPx);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
  } else {
    ctx.fillStyle = ink;
  }
  drawLevel({ ctx, pxPerMm, originPx: canvasPx / 2 }, fitStartGroup(sizeMm));
  ctx.globalCompositeOperation = "source-over";
}

const cache = new Map<string, THREE.CanvasTexture>();

/** A cached chart texture. One per (size, polarity) — targets share them. */
export function usafChartTexture(sizeMm: number, polarity: Polarity, ink: string) {
  const key = `${sizeMm.toFixed(2)}|${polarity}|${ink}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  const ctx = canvas.getContext("2d")!;
  drawUsaf1951(ctx, { sizeMm, canvasPx: CANVAS_PX, polarity, ink });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  cache.set(key, texture);
  return texture;
}
