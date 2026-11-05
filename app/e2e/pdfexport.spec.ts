import { test, expect } from "@playwright/test";
import fs from "node:fs";
import zlib from "node:zlib";
import { loginIfNeeded } from "./helpers";

// The figure export can also write a PDF — one page, the composited
// figure (bench + callout labels) as a lossless image, sized so the resolution
// multiplier is the print density.
//
// The file is written by hand in app/src/pdf.ts, so this test checks the parts a
// reader would choke on: the trailer's startxref pointing at the table, every
// xref offset landing on its object, and an image whose inflated stream is
// exactly width x height x 3 bytes.

function inflatedImage(pdf: Buffer): { width: number; height: number; bytes: number } {
  const dict = /\/Subtype \/Image [^>]*?\/Width (\d+) \/Height (\d+)[^>]*?>>/s.exec(
    pdf.toString("latin1"),
  );
  if (!dict) throw new Error("no image XObject in the PDF");
  const start = pdf.indexOf("stream\n", dict.index) + "stream\n".length;
  const end = pdf.indexOf("\nendstream", start);
  return {
    width: Number(dict[1]),
    height: Number(dict[2]),
    bytes: zlib.inflateSync(pdf.subarray(start, end)).length,
  };
}

function checkXref(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe("xref");
  const [, count] = /xref\n0 (\d+)\n/.exec(text.slice(startxref))!;
  const entries = text
    .slice(startxref)
    .split("\n")
    .slice(3, Number(count) + 2)      // skip "xref", "0 n", and the free entry
    .map((line) => Number(line.slice(0, 10)));
  entries.forEach((offset, i) => {
    expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true);
  });
  return Number(count);
}

test("the export sheet can write the figure as a one-page PDF", async ({ page, baseURL }) => {
  const projectName = `e2e-pdf-${Date.now()}`;

  try {
    await page.goto("/");
    await loginIfNeeded(page);
    await page.getByRole("button", { name: "+ New project" }).click();
    await page.getByPlaceholder("Project name (e.g. team_a_setup)").fill(projectName);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.locator("canvas")).toBeVisible();
    await page.getByRole("button", { name: "Snapshot" }).click();

    await page.locator(".figure-export-dialog select").first().selectOption("pdf");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "書き出す" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^${projectName}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.pdf$`),
    );

    const path = await download.path();
    expect(path).not.toBeNull();
    const pdf = fs.readFileSync(path!);
    expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.subarray(-6).toString("latin1")).toBe("%%EOF\n");
    expect(pdf.toString("latin1")).toContain("/Type /Page ");
    expect(checkXref(pdf)).toBe(7);          // catalog…info, opaque so no SMask

    const image = inflatedImage(pdf);
    expect(image.width).toBeGreaterThan(100);
    expect(image.height).toBeGreaterThan(100);
    // Lossless DeviceRGB: three bytes per pixel, nothing dropped or padded.
    expect(image.bytes).toBe(image.width * image.height * 3);
  } finally {
    await page.request.post(`${baseURL}/api/projects/${projectName}/remove`).catch(() => undefined);
  }
});
