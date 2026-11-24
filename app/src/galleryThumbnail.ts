/**
 * Turning a captured viewport frame into the gallery card's picture.
 *
 * The editor takes the frame (Detailed view, the camera where the user left
 * it) and this crops it to the card's 16:10 and scales it to 480x300 — the
 * size and aspect the in-browser bench thumbnails (`ui/benchThumbs.tsx`) use,
 * so a saved picture and a drawn one sit in the same card the same way.
 * PNG, as asked for: the picture is stored once on the server, not in every
 * browser's localStorage, so the size that pushed benchThumbs to JPEG matters
 * less here.
 */
export const CARD_WIDTH = 480;
export const CARD_HEIGHT = 300;

/**
 * The centred source rectangle that covers a `targetW x targetH` box without
 * stretching — what CSS `object-fit: cover` would show.
 */
export function coverCrop(
  srcW: number, srcH: number, targetW = CARD_WIDTH, targetH = CARD_HEIGHT,
): { sx: number; sy: number; sw: number; sh: number } {
  const target = targetW / targetH;
  if (srcW / srcH > target) {
    const sw = srcH * target;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / target;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

export async function toCardPicture(frame: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(frame);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D context for the gallery thumbnail");
    ctx.imageSmoothingQuality = "high";
    const { sx, sy, sw, sh } = coverCrop(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, CARD_WIDTH, CARD_HEIGHT);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("thumbnail encode failed"))),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}
