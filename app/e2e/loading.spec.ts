import { test, expect } from "@playwright/test";

import { loginIfNeeded, openProject } from "./helpers";

// A slow action says what it is waiting for, and the indicator goes away when
// it is done. Switching a real bench to Detailed reads every hi-res CAD model,
// which takes seconds, so the shared indicator (useBusy) must show for it.

test("switching to Detailed shows what it is waiting for, then clears", async ({ page, baseURL }) => {
  const project = `e2e-loading-${Date.now()}`;
  const api = baseURL!;
  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "4f_default" },
    });
    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, project);
    await expect(page.locator("canvas")).toBeVisible();

    const detailed = page.locator(".seg-toggle button").nth(1);
    await detailed.click();

    const indicator = page.locator(".lod-loading");
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText("Detailed");
    // Pressing the switch again while it loads must not start a second load.
    await expect(detailed).toBeDisabled();

    await expect(indicator).toBeHidden({ timeout: 90_000 });
    await expect(detailed).toHaveClass(/active/);
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`);
  }
});
