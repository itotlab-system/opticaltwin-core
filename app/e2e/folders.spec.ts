/**
 * Filing projects in the gallery: folders and the archive.
 *
 * A folder is a label the project carries, not a directory — it exists because
 * some project is in it, and its tab disappears when the last one leaves. The
 * archive is the same mechanism used to take a finished setup off the board
 * without deleting anyone's work.
 *
 * These run against the real projects/ directory, so each test makes its own
 * throwaway project and removes it again in a finally.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cardAction, loginIfNeeded } from "./helpers";

function cardNamed(page: Page, name: string) {
  return page.locator(".card").filter({
    has: page.locator(".card-name", { hasText: new RegExp(`^${name}$`) }),
  });
}

/** Start from "All projects" — the tab is remembered across page loads. */
async function clearTab(page: Page) {
  await page.addInitScript(() => localStorage.removeItem("ot.galleryFolder"));
}

test("a project moves into a new folder, and the folder gets a tab", async ({
  page, baseURL,
}) => {
  const project = `e2e-folder-${Date.now()}`;
  const folder = `2027年度 ${Date.now()}`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "blank" },
    });
    await clearTab(page);
    await page.goto("/");
    await loginIfNeeded(page);
    await expect(cardNamed(page, project)).toBeVisible();

    await cardAction(page, project, "Move to folder…");
    await page.locator(".folder-new input").fill(folder);
    await page.locator(".folder-new .primary").click();

    // The tab appears, and the card now sits under the folder's heading
    // rather than loose in the gallery.
    const tab = page.getByRole("tab", { name: folder });
    await expect(tab).toBeVisible();
    const section = page.locator(".folder-section", { hasText: folder });
    await expect(section.locator(".card-name", { hasText: project })).toBeVisible();

    // Its own tab shows it; another folder's view does not.
    await tab.click();
    await expect(cardNamed(page, project)).toBeVisible();
    await page.getByRole("tab", { name: "All projects" }).click();
    await expect(cardNamed(page, project)).toBeVisible();
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`);
  }
});

test("the folder survives a reload, and emptying it takes the tab away", async ({
  page, baseURL,
}) => {
  const project = `e2e-folder2-${Date.now()}`;
  const folder = `卒論 ${Date.now()}`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "blank" },
    });
    await page.request.post(`${api}/api/projects/${project}/meta`, {
      data: { folder },
    });
    await clearTab(page);
    await page.goto("/");
    await loginIfNeeded(page);
    // Filing lives in projects/<n>/project.json, so it is there on a cold load.
    await expect(page.getByRole("tab", { name: folder })).toBeVisible();

    await cardAction(page, project, "Move to folder…");
    await page.locator(".folder-opt", { hasText: "No folder" }).click();
    await expect(page.getByRole("tab", { name: folder })).toHaveCount(0);
    await expect(cardNamed(page, project)).toBeVisible();
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`);
  }
});

test("archiving hides a project behind the drawer, and restoring brings it back", async ({
  page, baseURL,
}) => {
  const project = `e2e-archive-${Date.now()}`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "blank" },
    });
    await clearTab(page);
    await page.goto("/");
    await loginIfNeeded(page);
    await expect(cardNamed(page, project)).toBeVisible();

    await cardAction(page, project, "Archive");
    // Off the board: the drawer is collapsed, so the card is gone from view.
    await expect(cardNamed(page, project)).toHaveCount(0);

    const drawer = page.locator(".archive-drawer");
    await expect(drawer).toBeVisible();
    await drawer.locator(".archive-toggle").click();
    await expect(cardNamed(page, project)).toBeVisible();

    // Nothing was deleted — it comes back exactly as it was.
    await cardAction(page, project, "Restore from archive");
    await expect(page.locator(".cards").first().locator(".card-name", {
      hasText: project,
    })).toBeVisible();
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`);
  }
});
