import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Renaming a project from its gallery card. The name edits in
// place, the card keeps its parts, and the old name is gone.

import { cardAction, loginIfNeeded, openProject } from "./helpers";

/** The card whose name is exactly `name`.
 *
 * Matched on `.card-name` rather than the card's text so a name that is a
 * prefix of another one ("bench" vs "bench_copy") can't match two cards. Note
 * a card being renamed has no `.card-name` at all — its name lives in an input
 * value, which no text locator sees.
 */
function cardNamed(page: Page, name: string) {
  return page.locator(".card").filter({
    has: page.locator(".card-name", { hasText: new RegExp(`^${name}$`) }),
  });
}

test("the card menu renames a project in place", async ({ page, baseURL }) => {
  const project = `e2e-rename-${Date.now()}`;
  const renamed = `e2e-renamed-${Date.now()}`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "4f_default" },
    });

    await page.goto("/");
    await loginIfNeeded(page);

    const card = cardNamed(page, project);
    await expect(card).toBeVisible();
    const boardBefore = await card.locator(".card-board").innerText();

    await cardAction(page, project, "Rename");
    const field = page.locator(".card-rename");
    await expect(field).toBeFocused();
    await field.fill(renamed);
    await field.press("Enter");

    await expect(cardNamed(page, renamed)).toBeVisible();
    // The rename moved the setup rather than making a second copy of it.
    await expect(cardNamed(page, project)).toHaveCount(0);
    expect(await cardNamed(page, renamed).locator(".card-board").innerText())
      .toBe(boardBefore);

    expect((await page.request.get(`${api}/api/projects/${project}`)).status())
      .toBe(404);
    const moved = await (await page.request.get(
      `${api}/api/projects/${renamed}`)).json();
    expect(moved.components.length).toBeGreaterThan(0);

    // The renamed card still opens.
    await openProject(page, renamed);
    await expect(page.locator("canvas")).toBeVisible();
  } finally {
    for (const name of [renamed, project]) {
      await page.request.post(`${api}/api/projects/${name}/remove`)
        .catch(() => undefined);
    }
  }
});

test("Escape leaves the name alone", async ({ page, baseURL }) => {
  const project = `e2e-rename-esc-${Date.now()}`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "blank" },
    });

    await page.goto("/");
    await loginIfNeeded(page);

    await cardAction(page, project, "Rename");
    const field = page.locator(".card-rename");
    await field.fill("e2e-discard-me");
    await field.press("Escape");

    await expect(cardNamed(page, project)).toHaveCount(1);
    await expect(cardNamed(page, "e2e-discard-me")).toHaveCount(0);
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`)
      .catch(() => undefined);
  }
});

test("a name already taken is refused and the project keeps its own",
  async ({ page, baseURL }) => {
    const project = `e2e-clash-a-${Date.now()}`;
    const taken = `e2e-clash-b-${Date.now()}`;
    const api = baseURL!;

    try {
      for (const name of [project, taken]) {
        await page.request.post(`${api}/api/projects`, {
          data: { name, template: "blank" },
        });
      }

      await page.goto("/");
      await loginIfNeeded(page);

      await cardAction(page, project, "Rename");
      const field = page.locator(".card-rename");
      await field.fill(taken);
      await field.press("Enter");

      await expect(page.locator(".err")).toBeVisible();
      await expect(cardNamed(page, project)).toHaveCount(1);
      await expect(cardNamed(page, taken)).toHaveCount(1);
    } finally {
      for (const name of [project, taken]) {
        await page.request.post(`${api}/api/projects/${name}/remove`)
          .catch(() => undefined);
      }
    }
  });
