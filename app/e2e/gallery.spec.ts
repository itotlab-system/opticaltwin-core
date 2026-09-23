/**
 * The project gallery's bench thumbnails.
 *
 * Each card shows a render of its own setup, drawn once by a single offscreen
 * canvas and cached in localStorage under the project's layer mtime. The two
 * things worth guarding are that the pictures appear at all, and that they are
 * reused on the next visit — redrawing every bench on every page load means
 * refetching every project payload.
 */
import { expect, test } from "@playwright/test";
import { cardAction, loginIfNeeded } from "./helpers";

const THUMB_KEYS = "ot.benchThumb.";

test.describe("project gallery", () => {
  test("draws a picture of every bench", async ({ page }) => {
    await page.addInitScript((prefix) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(prefix)) localStorage.removeItem(key);
      }
    }, THUMB_KEYS);
    await page.goto("/");
    await loginIfNeeded(page);

    const cards = page.locator(".card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    // The forge draws one bench at a time, so a full gallery takes a while.
    await expect(page.locator(".card-thumb img")).toHaveCount(count, {
      timeout: 120_000,
    });

    const src = await page.locator(".card-thumb img").first().getAttribute("src");
    expect(src?.startsWith("data:image/jpeg")).toBe(true);
  });

  test("reuses the cached picture instead of redrawing", async ({ page }) => {
    await page.goto("/");
    await loginIfNeeded(page);
    const cards = page.locator(".card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    await expect(page.locator(".card-thumb img")).toHaveCount(count, {
      timeout: 120_000,
    });

    // Second visit: no project payload may be fetched, because drawing is what
    // needs the geometry and nothing needs drawing.
    const payloads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (/^\/api\/projects\/[^/]+$/.test(url.pathname)) payloads.push(url.pathname);
    });
    await page.reload();
    await loginIfNeeded(page);
    await expect(page.locator(".card-thumb img")).toHaveCount(count);
    await page.waitForTimeout(1500);
    expect(payloads).toEqual([]);
  });
});

test.describe("card actions menu", () => {
  test("stays out of the way until the card is pointed at", async ({ page }) => {
    await page.goto("/");
    await loginIfNeeded(page);
    const card = page.locator(".card").first();
    await expect(card).toBeVisible();

    const menuButton = card.locator(".card-menu-btn");
    // Present for the accessibility tree, but not competing with the card.
    await expect(menuButton).toHaveCSS("opacity", "0");
    await card.hover();
    await expect(menuButton).toHaveCSS("opacity", "1");
  });

  test("choosing an action does not also open the project", async ({ page }) => {
    await page.goto("/");
    await loginIfNeeded(page);
    const card = page.locator(".card").first();
    await expect(card).toBeVisible();

    await card.locator(".card-menu-btn").click();
    await card.getByRole("menuitem", { name: "Rename", exact: true }).click();
    // Renaming happens in the card; the editor must not have opened under it.
    await expect(page.locator(".card-rename")).toBeFocused();
    await expect(page.locator(".gallery")).toBeVisible();
  });

  test("clicking away closes the menu and leaves the gallery", async ({ page }) => {
    await page.goto("/");
    await loginIfNeeded(page);
    const card = page.locator(".card").first();
    await expect(card).toBeVisible();

    await card.locator(".card-menu-btn").click();
    const menu = card.getByRole("menu");
    await expect(menu).toBeVisible();

    await page.locator(".gallery-head h1").click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".gallery")).toBeVisible();
  });

  test("Escape closes the menu and returns focus to its button", async ({ page }) => {
    await page.goto("/");
    await loginIfNeeded(page);
    const card = page.locator(".card").first();
    await expect(card).toBeVisible();

    const menuButton = card.locator(".card-menu-btn");
    await menuButton.click();
    await expect(card.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card.getByRole("menu")).toHaveCount(0);
    await expect(menuButton).toBeFocused();
  });

  test("a card opens from the keyboard", async ({ page }) => {
    await page.goto("/");
    await loginIfNeeded(page);
    const card = page.locator(".card").first();
    await expect(card).toBeVisible();
    const project = await card.locator(".card-name").innerText();

    await card.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".outliner")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".proj-name")).toHaveText(project);
  });

  test("a cancelled delete keeps the project and its picture", async ({ page, baseURL }) => {
    // Its own throwaway bench: a delete that somehow went through must not be
    // able to take one of the lab's setups with it.
    const project = `e2e-delete-${Date.now()}`;
    const api = baseURL!;
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "blank" },
    });
    try {
      page.on("dialog", (d) => d.dismiss());
      await page.goto("/");
      await loginIfNeeded(page);
      const card = page.locator(".card").filter({
        has: page.locator(".card-name", { hasText: new RegExp(`^${project}$`) }),
      });
      await expect(card).toHaveCount(1);
      // Cached pictures are only pruned once a project is really gone, so a
      // cancelled delete must leave every stored thumbnail where it was.
      const stored = () => page.evaluate(
        (prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)).sort(),
        "ot.benchThumb.",
      );
      const before = await stored();

      await cardAction(page, project, "Delete");
      await expect(card).toHaveCount(1);
      expect(await stored()).toEqual(before);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`);
    }
  });
});
