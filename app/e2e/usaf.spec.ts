import { test, expect } from "@playwright/test";
import { loginIfNeeded, openProject } from "./helpers";

// The USAF 1951 chart is drawn, not modelled: no target CAD in the library
// carries the pattern. These cover the drawing itself and the fact that a
// project holding a target still renders.

test("the chart punches bars out of the chrome field", async ({ page }) => {
  await page.goto("/");
  await loginIfNeeded(page);

  const stats = await page.evaluate(async () => {
    const mod = await import("/src/scene/usaf1951.ts");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 800;
    const ctx = canvas.getContext("2d")!;
    mod.drawUsaf1951(ctx, {
      sizeMm: 76.2, canvasPx: 800, polarity: "negative", ink: "#3a3d42",
    });
    const { data } = ctx.getImageData(0, 0, 800, 800);
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 8) clear++;
    return {
      clearFraction: clear / (800 * 800),
      startFor3Inch: mod.fitStartGroup(76.2),
      startFor1Inch: mod.fitStartGroup(25.4),
      lp0: mod.lpPerMm(0, 1),
      barWidth0: mod.barWidthMm(0, 1),
    };
  });

  // Group 0 element 1 is the definition's anchor: 1 line pair per mm, so a
  // 0.5 mm bar. If this drifts the whole chart is the wrong physical size.
  expect(stats.lp0).toBeCloseTo(1, 6);
  expect(stats.barWidth0).toBeCloseTo(0.5, 6);
  // A 3" target takes the full -2 chart; a 1" one has to start finer.
  expect(stats.startFor3Inch).toBe(-2);
  expect(stats.startFor1Inch).toBeGreaterThan(-2);
  // Bars actually got punched out, and did not eat the whole substrate.
  expect(stats.clearFraction).toBeGreaterThan(0.02);
  expect(stats.clearFraction).toBeLessThan(0.35);
});

test("a project holding a target renders without error",
  async ({ page, baseURL }) => {
    // A throwaway bench with one target on it, rather than a lab member's real
    // project: that one can be renamed or archived under the test, and its name
    // has no business in the published copy of this file.
    const project = `e2e-usaf-${Date.now()}`;
    const api = baseURL!;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "blank" },
      });
      const r = await page.request.get(`${api}/api/projects/${project}`);
      const assets = Object.keys((await r.json()).libraryPreviews ?? {});
      const target = assets.find((a) => a.startsWith("Target/"));
      // Target parts are imported from vendor CAD, which the public export
      // leaves out, so a checkout without them has nothing to render here.
      test.skip(!target, "no Target part in this component library");
      await page.request.post(`${api}/api/projects/${project}/add`, {
        data: { asset: target },
      });

      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas").first()).toBeVisible();
      await page.waitForTimeout(3000);

      expect(errors).toEqual([]);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
