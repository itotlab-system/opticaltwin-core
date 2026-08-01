import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Issue #156: the viewport background is pickable (dark / gray / light)
// independently of the UI theme, so a mid-gray keeps black-anodized mounts and
// silver optics readable at the same time.

import { loginIfNeeded, openProject } from "./helpers";

/**
 * Read the rendered background straight off the WebGL canvas. A corner pixel
 * is empty space — no board, no parts — so it is the background colour.
 * The canvas is created with preserveDrawingBuffer, so this is safe to do
 * outside a render callback.
 */
async function cornerPixel(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const off = document.createElement("canvas");
    off.width = 1;
    off.height = 1;
    const ctx = off.getContext("2d")!;
    ctx.drawImage(canvas, 3, 3, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  });
}

const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The same read, but only once the canvas has actually drawn a frame — a
 * fresh page can hand back an untouched (black) drawing buffer for a moment.
 * Two identical, non-black reads in a row means the frame has settled.
 */
async function settledPixel(page: Page): Promise<[number, number, number]> {
  let previous: [number, number, number] | null = null;
  let current: [number, number, number] = [0, 0, 0];
  await expect.poll(async () => {
    previous = current;
    current = await cornerPixel(page);
    return luma(current) > 0 && current.join() === previous.join();
  }, { intervals: [200, 200, 300, 300, 500, 500, 500, 1000] }).toBe(true);
  return current;
}

test("the viewport background switches between dark, gray and light",
  async ({ page, baseURL }) => {
    const project = `e2e-bg-${Date.now()}`;
    const api = baseURL!;

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });

      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();

      const swatch = (name: string) => page.locator(`.bg-swatch.bg-${name}`);

      // Default is "auto", which follows the dark UI theme — the behaviour
      // that existed before this setting.
      await expect(swatch("dark")).toHaveClass(/active/);
      const dark = await settledPixel(page);

      // --- gray ---
      await swatch("gray").click();
      await expect(swatch("gray")).toHaveClass(/active/);
      await expect(swatch("dark")).not.toHaveClass(/active/);
      const gray = await settledPixel(page);
      // #5a6069 — allow for colour-space round-tripping through the canvas.
      expect(Math.abs(gray[0] - 0x5a)).toBeLessThan(16);
      expect(Math.abs(gray[1] - 0x60)).toBeLessThan(16);
      expect(Math.abs(gray[2] - 0x69)).toBeLessThan(16);

      // --- light ---
      await swatch("light").click();
      const light = await settledPixel(page);

      // Three genuinely distinct steps, darkest to lightest.
      expect(luma(dark)).toBeLessThan(luma(gray));
      expect(luma(gray)).toBeLessThan(luma(light));

      // --- the choice survives a reload, and is independent of the theme ---
      await swatch("gray").click();
      await page.reload();
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();
      await expect(swatch("gray")).toHaveClass(/active/);
      expect(luma(await settledPixel(page))).toBeCloseTo(luma(gray), -1);

      // Switching the UI theme leaves an explicitly chosen background alone.
      await page.getByTitle("Theme / テーマ").click();
      await expect(swatch("gray")).toHaveClass(/active/);
      expect(luma(await settledPixel(page))).toBeCloseTo(luma(gray), -1);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
