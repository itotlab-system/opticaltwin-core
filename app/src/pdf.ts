/**
 * A one-page PDF holding a single image — the whole of what a figure export
 * needs, written by hand rather than pulled from a PDF library.
 *
 * Why by hand: the figure is *already* composited (bench frame + callout layer)
 * into one canvas by `figureExport`, so the only job left is "put this bitmap on
 * a page at the right physical size". A PDF library would add a few hundred kB
 * to the bundle for that, and the one thing it could offer beyond this — labels
 * as real PDF text — is unavailable to us anyway: the labels are routinely
 * Japanese, and PDF's built-in fonts are Latin-only, so vector text would mean
 * shipping a CJK font. A co-author who wants editable type exports SVG, which
 * keeps the labels as `<text>`; PDF is the format for "hand this to the journal".
 *
 * The image goes in as raw 8-bit samples under /FlateDecode, i.e. losslessly —
 * line art, hairline leaders and small type are exactly what JPEG smears. When
 * the export asked for a transparent background, the alpha channel rides along
 * as an /SMask, so the page shows through.
 */

const enc = new TextEncoder();

/** A byte buffer this module owns outright — what Blob and the writer accept. */
type Bytes = Uint8Array<ArrayBuffer>;

/** zlib-wrapped deflate, which is what /FlateDecode means. */
async function deflate(bytes: Bytes): Promise<Bytes | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A text string for the Info dictionary. Project names are routinely Japanese,
 * and a literal `(…)` string is read as PDFDocEncoding — the bytes come back as
 * mojibake in a reader's title bar — so it goes in as a UTF-16BE hex string,
 * which every viewer understands.
 */
function pdfTextString(text: string): string {
  let hex = "FEFF";
  for (const unit of text) {
    for (let i = 0; i < unit.length; i++) {
      hex += unit.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return `<${hex}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}'`
  );
}

/** Separates interleaved RGBA into a colour plane and, if used, an alpha plane. */
function splitChannels(rgba: Uint8ClampedArray): { rgb: Bytes; alpha: Bytes | null } {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  let opaque = true;
  for (let i = 0, j = 0; i < pixels; i++, j += 3) {
    const k = i * 4;
    rgb[j] = rgba[k];
    rgb[j + 1] = rgba[k + 1];
    rgb[j + 2] = rgba[k + 2];
    alpha[i] = rgba[k + 3];
    if (rgba[k + 3] !== 255) opaque = false;
  }
  return { rgb, alpha: opaque ? null : alpha };
}

/** Collects the file's byte chunks while tracking each object's offset. */
class PdfWriter {
  private chunks: Bytes[] = [];
  private length = 0;
  /** Byte offset of object n, indexed by object number. */
  readonly offsets: number[] = [];

  push(part: string | Bytes): void {
    const bytes = typeof part === "string" ? enc.encode(part) : part;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  /** Starts object `id` here and writes `body`, plus an optional stream. */
  object(id: number, body: string, stream?: Bytes): void {
    this.offsets[id] = this.length;
    this.push(`${id} 0 obj\n${body}\n`);
    if (stream) {
      this.push("stream\n");
      this.push(stream);
      this.push("\nendstream\n");
    }
    this.push("endobj\n");
  }

  get size(): number {
    return this.length;
  }

  blob(): Blob {
    return new Blob(this.chunks, { type: "application/pdf" });
  }
}

export interface PdfImageOptions {
  /** Page size in PDF points (1/72 inch). The image fills the page exactly. */
  widthPt: number;
  heightPt: number;
  title?: string;
  date?: Date;
}

/**
 * Wraps one RGBA bitmap in a single-page PDF, the image covering the page.
 *
 * `widthPt`/`heightPt` are what set the print resolution: the same bitmap on a
 * smaller page is simply a denser figure.
 */
export async function imageToPdf(
  image: ImageData,
  { widthPt, heightPt, title, date = new Date() }: PdfImageOptions,
): Promise<Blob> {
  const { rgb, alpha } = splitChannels(image.data);
  const [rgbZ, alphaZ] = await Promise.all([deflate(rgb), alpha ? deflate(alpha) : null]);

  const w = image.width;
  const h = image.height;
  const hasAlpha = alpha !== null;
  const SMASK_ID = 7;

  // The image XObject's own space is the unit square; the `cm` scales it up to
  // the page, so the page size alone decides the figure's physical size.
  const content = enc.encode(
    `q\n${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`,
  );

  const imageBytes = rgbZ ?? rgb;
  const w8 = new PdfWriter();
  w8.push("%PDF-1.4\n%âãÏÓ\n");
  w8.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w8.object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  w8.object(
    3,
    "<< /Type /Page /Parent 2 0 R " +
      `/MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(2)}] ` +
      "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
  );
  w8.object(
    4,
    "<< /Type /XObject /Subtype /Image " +
      `/Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      (rgbZ ? "/Filter /FlateDecode " : "") +
      (hasAlpha ? `/SMask ${SMASK_ID} 0 R ` : "") +
      `/Length ${imageBytes.length} >>`,
    imageBytes,
  );
  w8.object(5, `<< /Length ${content.length} >>`, content);
  w8.object(
    6,
    "<< /Producer (OpticalTwin) " +
      (title ? `/Title ${pdfTextString(title)} ` : "") +
      `/CreationDate (${pdfDate(date)}) >>`,
  );
  if (hasAlpha) {
    const maskBytes = alphaZ ?? alpha;
    w8.object(
      SMASK_ID,
      "<< /Type /XObject /Subtype /Image " +
        `/Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 ` +
        (alphaZ ? "/Filter /FlateDecode " : "") +
        `/Length ${maskBytes.length} >>`,
      maskBytes,
    );
  }

  const count = hasAlpha ? SMASK_ID + 1 : SMASK_ID;
  const startxref = w8.size;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    xref += `${String(w8.offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  w8.push(xref);
  w8.push(
    `trailer\n<< /Size ${count} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
  );
  return w8.blob();
}
