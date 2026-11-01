import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Name-based edit tracking: the login is one shared password, so a browser is
// asked once who it is, remembers it, and every edit is recorded under that
// name in projects/<n>/activity.json.

import { expandAllOutlinerTypes, giveEditorNameIfAsked, openProject } from "./helpers";

async function passwordOnly(page: import("@playwright/test").Page) {
  const field = page.locator("#login-password");
  const shown = await field
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) return;
  await field.fill(process.env.OT_PASSWORD || "dev");
  await field.press("Enter");
}

// The dev server runs from the repository root, one level above app/.
const activityFile = (project: string) =>
  path.join(process.cwd(), "..", "projects", project, "activity.json");

test("a fresh browser is asked its name once, and edits are recorded under it",
  async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const project = `e2e-editor-${Date.now()}`;
    const api = baseURL!;
    const name = "山田 e2e";

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });

      await page.goto("/");
      await passwordOnly(page);

      // Asked over the app, and it cannot be waved away: an edit made before
      // it would be recorded as nobody.
      const prompt = page.locator(".name-pick");
      await expect(prompt).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(prompt).toBeVisible();

      await giveEditorNameIfAsked(page, name);
      await expect(prompt).toHaveCount(0);
      await expect(page.locator(".editor-chip")).toHaveText(name);

      // Remembered: a reload does not ask again.
      await page.reload();
      await passwordOnly(page);
      await expect(page.locator(".editor-chip")).toHaveText(name);
      await expect(prompt).toHaveCount(0);

      // An edit through the UI lands in the tally under that name.
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();
      await expandAllOutlinerTypes(page);
      const rows = page.locator(".outliner .node");
      const before = await rows.count();
      await rows.nth(0).click();
      page.once("dialog", (d) => d.accept());
      await page.keyboard.press("Delete");
      await expect(rows).toHaveCount(before - 1);

      await expect.poll(() => fs.existsSync(activityFile(project))).toBe(true);
      const activity = JSON.parse(fs.readFileSync(activityFile(project), "utf8"));
      const days = Object.values(activity.days) as Record<string, number>[];
      expect(days).toHaveLength(1);
      expect(days[0][name]).toBeGreaterThanOrEqual(1);
      expect(activity.last.name).toBe(name);

      // …and the gallery card says who made that edit, next to when.
      await page.getByRole("button", { name: /Projects|プロジェクト/ }).first().click();
      const card = page.locator(".card", { hasText: project }).first();
      await expect(card.locator(".card-editor")).toHaveText(name);

      // The chip reopens the dialog to change the name, and Esc closes it then.
      await page.locator(".editor-chip").click();
      await expect(prompt).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(prompt).toHaveCount(0);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
