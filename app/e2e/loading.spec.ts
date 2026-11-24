import { test, expect } from "@playwright/test";

import { loginIfNeeded, openProject } from "./helpers";

// A slow action says what it is waiting for, and the indicator goes away when
// it is done. Opening a bench reads every hi-res CAD model, which can take
// seconds, so the shared indicator (useBusy) must show for it.

test("opening a bench shows what it is waiting for, then clears", async ({ page, baseURL }) => {
  const project = `e2e-loading-${Date.now()}`;
  const api = baseURL!;
  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "4f_default" },
    });
    // Hold the project payload back so the indicator is visible long enough
    // to be seen, however fast this machine reads the CAD.
    await page.route(`**/api/projects/${project}?*`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, project);

    const indicator = page.locator(".lod-loading");
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText(/Opening the bench|ベンチを開いています/);

    await expect(indicator).toBeHidden({ timeout: 90_000 });
    await expect(page.locator("canvas")).toBeVisible();
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`);
  }
});
