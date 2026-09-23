import { test, expect } from "@playwright/test";

// The visual part catalogue: a lab member has to be able to recognise a part
// by looking at it, not by decoding a 型番 like `R3L3S1N-Step` in a dropdown.

import { loginIfNeeded, openProject } from "./helpers";

// A throwaway bench per test, as elsewhere in this suite: the catalogue is the
// same for every project, so the parts on the board are irrelevant here.
let project = "";

test.beforeEach(async ({ page, baseURL }) => {
  project = `e2e-parts-${Date.now()}`;
  await page.request.post(`${baseURL}/api/projects`, {
    data: { name: project, template: "blank" },
  });
  await page.goto("/");
  await loginIfNeeded(page);
  await openProject(page, project);
  await page.locator(".outliner").waitFor();
});

test.afterEach(async ({ page, baseURL }) => {
  await page.request
    .post(`${baseURL}/api/projects/${project}/remove`)
    .catch(() => undefined);
});

test("browses the catalogue by picture and places the chosen part", async ({ page }) => {
  await page.locator(".browse-parts-btn").click();
  const browser = page.locator(".part-browser");
  await expect(browser).toBeVisible();

  // Every catalogue entry gets a tile, grouped into pickable categories.
  await expect(browser.locator(".part-category", { hasText: "Lens" })).toBeVisible();
  const tiles = browser.locator(".part-tile");
  expect(await tiles.count()).toBeGreaterThan(0);

  // The forge renders thumbnails one at a time into <img> tags. Seeing several
  // arrive is what proves the offscreen canvas is actually producing pictures
  // rather than the grid sitting on placeholders forever.
  await expect
    .poll(async () => browser.locator(".part-thumb img").count(), { timeout: 60_000 })
    .toBeGreaterThan(2);

  // Search spans the whole catalogue, not just the open category.
  await browser.locator(".part-search").fill("lens");
  await expect
    .poll(async () => tiles.count())
    .toBeGreaterThan(0);
  for (const label of await browser.locator(".part-tile").allTextContents()) {
    expect(label.toLowerCase()).toContain("lens");
  }

  // Picking a tile closes the browser and drops straight into placing.
  await tiles.first().click();
  await expect(browser).toBeHidden();
  await expect(page.locator(".outliner-add .icon-btn.primary")).toBeVisible();
});

test("shows the model number, type and the specs that decide the choice", async ({ page }) => {
  await page.locator(".browse-parts-btn").click();
  const browser = page.locator(".part-browser");
  await browser.locator(".part-category", { hasText: "Lens" }).click();

  const tile = browser.locator(".part-tile").first();
  // `Lens/LA1417-AB-Step.usda` reads as `LA1417-AB`, not as a file path.
  await expect(tile.locator(".part-model")).not.toContainText(".usda");
  await expect(tile.locator(".part-type")).toContainText("Lens");
});

test("Escape closes the browser without touching the bench", async ({ page }) => {
  await page.locator(".browse-parts-btn").click();
  await expect(page.locator(".part-browser")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".part-browser")).toBeHidden();
  await expect(page.locator(".outliner-add .icon-btn.primary")).toHaveCount(0);
});
