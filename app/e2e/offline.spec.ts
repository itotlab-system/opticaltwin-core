import { expect, test } from "@playwright/test";
import { loginIfNeeded, openProject } from "./helpers";

// The app is self-hosted, often on a lab network with no route to the
// internet. Nothing it needs to draw a bench may come from another host: a
// lighting image fetched from a CDN once took the whole editor down with it
// when the fetch failed.
test("the editor works with no access to the internet", async ({ page, baseURL }) => {
  const project = `e2e-offline-${Date.now()}`;
  await page.request.post(`${baseURL}/api/projects`, {
    data: { name: project, template: "blank" },
  });
  const external: string[] = [];
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => {
      external.push(route.request().url());
      return route.abort();
    },
  );
  try {
    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, project);

    await expect(page.locator(".outliner")).toBeVisible({ timeout: 30_000 });
    // Long enough for a failed fetch to have thrown and unmounted the page.
    await page.waitForTimeout(4_000);
    await expect(page.locator(".outliner")).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
    expect(external, "requests to other hosts").toEqual([]);
  } finally {
    await page.request.post(`${baseURL}/api/projects/${project}/remove`);
  }
});
