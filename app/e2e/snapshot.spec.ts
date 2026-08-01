import { test, expect } from "@playwright/test";
import fs from "node:fs";
import zlib from "node:zlib";

// Issue #92: a "Snapshot" button in the toolbar downloads the current
// viewport as a PNG named "<project>-<timestamp>.png".
// Issue #154: the X/Y/Z axis triad in the top-left corner is editor furniture
// and must not appear in that PNG.

type Rgb = [number, number, number];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Minimal decoder for the 8-bit RGB(A) PNGs canvas.toBlob() writes — enough to
// read individual pixels without pulling in an image library.
function decodePng(path: string): { width: number; height: number; at(x: number, y: number): Rgb } {
  const buf = fs.readFileSync(path);
  // IHDR fields sit at fixed offsets: width/height as big-endian uint32.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG: depth ${bitDepth}, color ${colorType}, interlace ${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;

  const parts: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") parts.push(buf.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += length + 12;   // length + type + data + crc
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));

  // Undo the per-scanline filter, which references the already-decoded pixels
  // to the left (a) and above (b, c).
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      pixels[y * stride + i] = value & 0xff;
    }
  }

  return {
    width,
    height,
    at(x: number, y: number): Rgb {
      const i = y * stride + x * channels;
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    },
  };
}

// The triad's axis colours (Viewport.tsx) are drawn with toneMapped={false},
// so they land in the PNG as (near-)exact values — nothing else in an empty
// project's render is close to them.
const AXIS_COLORS: Rgb[] = [[0xe5, 0x53, 0x4b], [0x2e, 0xa0, 0x43], [0x4c, 0x8d, 0xff]];

function findAxisColorPixels(png: ReturnType<typeof decodePng>): string[] {
  const hits: string[] = [];
  // The triad sits 58 px in from the top-left corner; scan the whole quadrant.
  for (let y = 0; y < Math.floor(png.height / 2); y++) {
    for (let x = 0; x < Math.floor(png.width / 2); x++) {
      const pixel = png.at(x, y);
      const match = AXIS_COLORS.some(
        (color) => color.every((value, i) => Math.abs(value - pixel[i]) <= 8),
      );
      if (match && hits.length < 5) hits.push(`(${x},${y}) = rgb(${pixel.join(",")})`);
    }
  }
  return hits;
}

import { loginIfNeeded } from "./helpers";

test("snapshot button downloads a non-blank PNG named after the project", async ({ page, baseURL }) => {
  const projectName = `e2e-snapshot-${Date.now()}`;

  try {
    await page.goto("/");
    await loginIfNeeded(page);
    await page.getByRole("button", { name: "+ New project" }).click();
    await page.getByPlaceholder("Project name (e.g. team_a_setup)").fill(projectName);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.locator("canvas")).toBeVisible();

    // The button stays disabled until the WebGL renderer's first frame
    // completes; Playwright's click() auto-waits for it to become enabled.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Snapshot" }).click(),
    ]);

    const filenamePattern = new RegExp(
      `^${projectName}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.png$`
    );
    expect(download.suggestedFilename()).toMatch(filenamePattern);

    const path = await download.path();
    expect(path).not.toBeNull();
    const stats = fs.statSync(path!);
    expect(stats.size).toBeGreaterThan(5000);

    const png = decodePng(path!);
    expect(png.width).toBeGreaterThan(100);
    expect(png.height).toBeGreaterThan(100);

    // #154: no axis triad in the captured image.
    expect(findAxisColorPixels(png)).toEqual([]);
  } finally {
    // The backend persists projects as real files under projects/<name>/ —
    // clean up the one this test created so repeated runs don't litter it.
    await page.request.post(`${baseURL}/api/projects/${projectName}/remove`).catch(() => undefined);
  }
});
