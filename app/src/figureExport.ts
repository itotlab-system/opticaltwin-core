/**
 * Turning the viewport into a figure file.
 *
 * The captured frame and the callouts come from two different worlds: the bench
 * is pixels read out of the WebGL drawing buffer, the labels are SVG laid out in
 * CSS pixels. This module is the one place they are put together, at whichever
 * multiple of screen resolution the export asked for.
 *
 * PNG rasterizes the callout SVG over the frame. SVG keeps the frame as an
 * embedded raster and the labels as real `<text>`, so a term can be retyped in
 * a vector editor without re-rendering the bench — the usual reason a figure
 * comes back from a co-author. PDF is the same composited picture as the PNG,
 * on a page whose physical size is the viewport at 96 dpi — so the resolution
 * multiplier is literally the print density (4x ≈ 384 dpi) and a journal can
 * take the file as it is.
 */
import { renderCalloutSvg } from "./callouts";
import type { AnchorPoint } from "./callouts";
import { imageToPdf } from "./pdf";
import type { FigureCallout } from "./types";

export type FigureFormat = "png" | "svg" | "pdf";
export type FigureBackground = "current" | "white" | "transparent";

/** CSS pixels are 96 per inch; PDF measures in points, 72 per inch. */
const PT_PER_CSS_PX = 72 / 96;

export interface CapturedFrame {
  blob: Blob;
  /** Layout size of the viewport, the coordinate system the callouts use. */
  cssWidth: number;
  cssHeight: number;
  /** How many device pixels the frame has per CSS pixel. */
  scale: number;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("figure layer failed to rasterize"));
    img.src = src;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

export async function composeFigure(
  frame: CapturedFrame,
  callouts: FigureCallout[],
  anchors: Record<string, AnchorPoint | undefined>,
  format: FigureFormat,
  title?: string,
): Promise<Blob> {
  const svg = renderCalloutSvg(callouts, anchors, frame.cssWidth, frame.cssHeight);

  if (format === "svg") {
    return new Blob(
      [renderCalloutSvg(callouts, anchors, frame.cssWidth, frame.cssHeight, {
        embeddedImage: await blobToDataUrl(frame.blob),
      })],
      { type: "image/svg+xml" },
    );
  }

  const width = Math.round(frame.cssWidth * frame.scale);
  const height = Math.round(frame.cssHeight * frame.scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D context for the figure export");

  const bench = await loadImage(await blobToDataUrl(frame.blob));
  ctx.drawImage(bench, 0, 0, width, height);
  if (callouts.length) {
    // The layer is drawn in CSS pixels and scaled up here, so the leader lines
    // and type stay the same size *relative to the bench* at any multiplier —
    // a 4x export is the same picture with more pixels, not thinner labels.
    const layer = await loadImage(svgDataUrl(svg));
    ctx.drawImage(layer, 0, 0, width, height);
  }

  if (format === "pdf") {
    return await imageToPdf(ctx.getImageData(0, 0, width, height), {
      widthPt: frame.cssWidth * PT_PER_CSS_PX,
      heightPt: frame.cssHeight * PT_PER_CSS_PX,
      title,
    });
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("figure encode failed")),
      "image/png",
    );
  });
}
