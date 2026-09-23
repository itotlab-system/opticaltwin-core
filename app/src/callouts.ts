/**
 * Figure callouts — the labelled leader lines that turn a bench into a paper
 * figure ("Fiber laser", "Polarizer", "Lens", …).
 *
 * Three decisions shape everything here:
 *
 * 1. **The text is free.** A callout starts out saying what the part is, but a
 *    paper picks its own vocabulary — "SLM" becomes "Phase modulator" or
 *    「位相変調素子」 depending on the venue. `defaultCalloutText` is a first
 *    guess, never a binding.
 * 2. **The box is placed in screen space.** Where a label sits is a question
 *    about the *picture* (which boxes overlap, which side has room), not about
 *    the bench, so `dx`/`dy` are pixels from the part's projected anchor. The
 *    leader line is re-derived from the live projection every frame, so orbiting
 *    keeps every label attached to its part.
 * 3. **It is drawn as SVG, not as drei `<Html>`.** The snapshot reads the WebGL
 *    drawing buffer (`renderer.domElement.toBlob`), which no DOM overlay is part
 *    of — an `<Html>` label is visible on screen and absent from the exported
 *    PNG. Keeping the layer as one SVG lets the exporter rasterize the very same
 *    markup over the captured frame, and hand out a vector SVG whose labels are
 *    still editable text.
 *
 * Everything in this module is pure so the on-screen layer and the exporter
 * cannot drift apart: both lay a callout out through `calloutLayout`.
 */
import type { Component, FigureCallout } from "./types";

export const DEFAULT_FONT_PX = 15;
export const MIN_FONT_PX = 8;
export const MAX_FONT_PX = 48;

/** Paper-figure look: white box, hairline border, near-black text. */
export const CALLOUT_STYLE = {
  boxFill: "#ffffff",
  boxStroke: "#d0d0d0",
  text: "#111111",
  leader: "#222222",
  radius: 3,
  padX: 7,
  padY: 4,
  lineGap: 1.32,
  leaderWidth: 1.4,
  dotRadius: 3.2,
  /** Kept in the SVG itself so an exported file looks the same off-machine. */
  fontFamily:
    "'Helvetica Neue', Helvetica, Arial, 'Hiragino Sans', 'Noto Sans JP', sans-serif",
} as const;

/**
 * The swatches offered per label. Small and named, not a colour wheel: a figure
 * wants a handful of unambiguous colours (a black line reads on a light bench,
 * a white one on a dark bench, a colour separates one arm from the other), and
 * a free picker mostly produces labels that are hard to read in print.
 */
export const LEADER_COLORS: { value: string; label: string }[] = [
  { value: "#222222", label: "黒" },
  { value: "#ffffff", label: "白" },
  { value: "#8a8a8a", label: "グレー" },
  { value: "#d92b2b", label: "赤" },
  { value: "#1f6feb", label: "青" },
  { value: "#0d9a63", label: "緑" },
];

/** "none" is a box with no fill — labels straight on top of the bench. */
export const BOX_COLORS: { value: string; label: string }[] = [
  { value: "#ffffff", label: "白" },
  { value: "#111111", label: "黒" },
  { value: "#e8e8e8", label: "薄いグレー" },
  { value: "#ffe98a", label: "黄" },
  { value: "none", label: "透明" },
];

export interface CalloutColors {
  leader: string;
  boxFill: string;
  boxStroke: string;
  dotFill: string;
  text: string;
}

/** sRGB luminance, enough to decide black-or-white text on a fill. */
function isLight(hex: string): boolean {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.55;
}

/**
 * The colours one callout is drawn in. The text colour is *derived*, never
 * stored: white text on a white box is a label the user cannot read back, and
 * the only reason they'd have picked it is a slip. A box with no fill borrows
 * the leader colour for its text and border, so the pair still reads as one
 * mark over whatever is behind it.
 */
export function calloutColors(callout: {
  lineColor?: string; boxColor?: string;
}): CalloutColors {
  const leader = callout.lineColor || CALLOUT_STYLE.leader;
  const fill = callout.boxColor || CALLOUT_STYLE.boxFill;
  if (fill === "none") {
    return { leader, boxFill: "none", boxStroke: leader, dotFill: "none", text: leader };
  }
  const light = isLight(fill);
  return {
    leader,
    boxFill: fill,
    boxStroke: light ? CALLOUT_STYLE.boxStroke : leader,
    dotFill: fill,
    text: light ? CALLOUT_STYLE.text : "#ffffff",
  };
}

/** Labels that belong in the picture: the ones not individually hidden. */
export function visibleCallouts(callouts: FigureCallout[]): FigureCallout[] {
  return callouts.filter((c) => !c.hidden);
}

export function createCalloutId(): string {
  return `callout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The label a new callout starts with: the part's optical type, title-cased
 * ("cylindrical_lens" → "Cylindrical lens"), falling back to the prim name.
 * Deliberately the *type* and not the 型番 — a figure says "Lens", not
 * "LA1417-AB".
 */
export function defaultCalloutText(component: Component | undefined): string {
  const type = component?.type?.trim();
  if (!type) return component?.name ?? "";
  const words = type.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : component?.name ?? "";
}

// One canvas for every measurement (a page gets few 2D contexts cheaply, but
// there is no reason to make more than one). Measuring rather than reading back
// getBBox keeps layout synchronous, which the export path needs: it builds the
// SVG string without ever putting it in the document.
let measureCtx: CanvasRenderingContext2D | null = null;

function textWidth(line: string, fontPx: number): number {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return line.length * fontPx * 0.6;   // headless fallback
  measureCtx.font = `${fontPx}px ${CALLOUT_STYLE.fontFamily}`;
  return measureCtx.measureText(line).width;
}

export interface CalloutLayout {
  lines: string[];
  fontPx: number;
  /** Box size in CSS pixels, padding included. */
  width: number;
  height: number;
}

export function calloutLayout(callout: FigureCallout): CalloutLayout {
  const fontPx = clampFont(callout.fontPx ?? DEFAULT_FONT_PX);
  const lines = (callout.text || " ").split("\n");
  const widest = lines.reduce((w, line) => Math.max(w, textWidth(line, fontPx)), 0);
  return {
    lines,
    fontPx,
    width: Math.ceil(widest) + CALLOUT_STYLE.padX * 2,
    height: Math.ceil(lines.length * fontPx * CALLOUT_STYLE.lineGap) + CALLOUT_STYLE.padY * 2,
  };
}

export function clampFont(fontPx: number): number {
  if (!Number.isFinite(fontPx)) return DEFAULT_FONT_PX;
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, fontPx));
}

export interface Rect { x: number; y: number; width: number; height: number; }

/** The label box, centred on the anchor plus the stored screen offset. */
export function calloutRect(
  anchor: { x: number; y: number },
  callout: FigureCallout,
  layout: CalloutLayout,
): Rect {
  return {
    x: anchor.x + callout.dx - layout.width / 2,
    y: anchor.y + callout.dy - layout.height / 2,
    width: layout.width,
    height: layout.height,
  };
}

/**
 * Where the leader line leaves the box: the point on its edge along the line to
 * the anchor. Attaching to an edge rather than a fixed corner is what lets a
 * label sit above, below or either side of its part and still look drawn by
 * hand — which side is used follows from where the user dragged the box.
 */
export function leaderStart(rect: Rect, anchor: { x: number; y: number }): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = anchor.x - cx;
  const dy = anchor.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  // Scale the direction until it first crosses an edge; the smaller of the two
  // ratios is the edge it actually leaves through.
  const tx = dx ? rect.width / 2 / Math.abs(dx) : Infinity;
  const ty = dy ? rect.height / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Baseline y of line `i` inside the box. */
export function lineBaseline(rect: Rect, layout: CalloutLayout, i: number): number {
  const lineHeight = layout.fontPx * CALLOUT_STYLE.lineGap;
  // +0.78em puts the baseline inside the line box rather than on its top edge.
  return rect.y + CALLOUT_STYLE.padY + i * lineHeight + layout.fontPx * 0.78;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface AnchorPoint { x: number; y: number; behind: boolean; }

/**
 * The callout layer as standalone SVG markup, in CSS-pixel coordinates.
 *
 * Used twice: rasterized over the captured frame for a PNG, and written out
 * as-is (over an embedded PNG) for a vector export whose labels are still real
 * `<text>` — the point of the SVG option is that a co-author can retype a term
 * in Illustrator without re-rendering the bench.
 */
export function renderCalloutSvg(
  callouts: FigureCallout[],
  anchors: Record<string, AnchorPoint | undefined>,
  width: number,
  height: number,
  options: { background?: string; embeddedImage?: string } = {},
): string {
  const body: string[] = [];
  if (options.background) {
    body.push(`<rect width="${width}" height="${height}" fill="${options.background}"/>`);
  }
  if (options.embeddedImage) {
    body.push(
      `<image x="0" y="0" width="${width}" height="${height}" `
      + `preserveAspectRatio="none" href="${options.embeddedImage}"/>`,
    );
  }
  const S = CALLOUT_STYLE;
  for (const callout of callouts) {
    if (callout.hidden) continue;                // kept in the project, out of the figure
    const anchor = anchors[callout.id];
    if (!anchor || anchor.behind) continue;      // part is behind the camera
    const layout = calloutLayout(callout);
    const rect = calloutRect(anchor, callout, layout);
    const start = leaderStart(rect, anchor);
    const C = calloutColors(callout);
    body.push(
      `<g>`
      + `<line x1="${round(start.x)}" y1="${round(start.y)}"`
      + ` x2="${round(anchor.x)}" y2="${round(anchor.y)}"`
      + ` stroke="${C.leader}" stroke-width="${S.leaderWidth}" stroke-linecap="round"/>`
      + `<circle cx="${round(anchor.x)}" cy="${round(anchor.y)}" r="${S.dotRadius}"`
      + ` fill="${C.dotFill}" stroke="${C.leader}" stroke-width="${S.leaderWidth}"/>`
      + `<rect x="${round(rect.x)}" y="${round(rect.y)}"`
      + ` width="${round(rect.width)}" height="${round(rect.height)}"`
      + ` rx="${S.radius}" fill="${C.boxFill}" stroke="${C.boxStroke}"/>`
      + layout.lines.map((line, i) =>
          `<text x="${round(rect.x + S.padX)}" y="${round(lineBaseline(rect, layout, i))}"`
          + ` font-family="${escapeXml(S.fontFamily)}" font-size="${layout.fontPx}"`
          + ` fill="${C.text}">${escapeXml(line)}</text>`).join("")
      + `</g>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
    + ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + body.join("")
    + `</svg>`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
