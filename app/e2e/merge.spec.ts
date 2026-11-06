import { test, expect } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

import { loginIfNeeded, openProject } from "./helpers";

// Switching a laser and placing a part answer with a light payload that the
// client merges, instead of re-fetching the whole bench: in Detailed mode the
// re-fetch was ~9 s and 45 MB on a large bench, and it rebuilt every mesh.

/** Full-scene fetches of this project made while `action` runs. */
async function fullFetchesDuring(page: Page, project: string, action: () => Promise<void>) {
  const fetches: Request[] = [];
  const watch = (r: Request) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "GET" && path === `/api/projects/${project}`) fetches.push(r);
  };
  page.on("request", watch);
  try {
    await action();
  } finally {
    page.off("request", watch);
  }
  return fetches;
}

async function serverComponents(page: Page, api: string, project: string) {
  const r = await page.request.get(`${api}/api/projects/${project}?renderMode=lo`);
  return ((await r.json()).components as { name: string }[]).map((c) => c.name).sort();
}

test.describe("light answers are merged, not reloaded", () => {
  let project = "";

  test.beforeEach(async ({ page, baseURL }) => {
    project = `e2e-merge-${Date.now()}`;
    await page.request.post(`${baseURL}/api/projects`, {
      data: { name: project, template: "4f_default" },
    });
    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, project);
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator(".laser-toggle")).toBeVisible();
  });

  test.afterEach(async ({ page, baseURL }) => {
    await page.request.post(`${baseURL}/api/projects/${project}/remove`);
  });

  test("switching the laser off merges the answer and is saved", async ({ page, baseURL }) => {
    const fetches = await fullFetchesDuring(page, project, async () => {
      const answer = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project}/lasers`));
      await page.locator(".laser-toggle").click();
      const body = await (await answer).json();
      expect(body.partial).toBe(true);
      await expect(page.locator(".laser-toggle")).not.toHaveClass(/active/);
    });
    expect(fetches).toHaveLength(0);

    await page.reload();
    await loginIfNeeded(page);
    await openProject(page, project);
    await expect(page.locator(".laser-toggle")).not.toHaveClass(/active/);
    void baseURL;
  });

  test("placing a part merges it and matches a reload", async ({ page, baseURL }) => {
    const before = await serverComponents(page, baseURL!, project);

    await page.locator(".browse-parts-btn").click();
    const browser = page.locator(".part-browser");
    await browser.locator(".part-category", { hasText: "Lens" }).click();
    await browser.locator(".part-tile").first().click();
    await expect(browser).toBeHidden();

    const fetches = await fullFetchesDuring(page, project, async () => {
      const answer = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project}/add`));
      const box = (await page.locator("canvas").boundingBox())!;
      // Toward the near edge of the board, clear of the parts in the middle.
      await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.75);
      const body = await (await answer).json();
      expect(body.partial).toBe(true);
      expect(body.added.map((c: { name: string }) => c.name)).toContain(body.name);
    });
    expect(fetches).toHaveLength(0);

    const after = await serverComponents(page, baseURL!, project);
    expect(after.length).toBeGreaterThan(before.length);
    // What the merged screen shows is what the server holds.
    await expect(page.locator(".status")).toContainText(String(after.length));
  });
});
