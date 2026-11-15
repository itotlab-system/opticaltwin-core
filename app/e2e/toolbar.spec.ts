import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginIfNeeded, openProject } from "./helpers";

// The editor toolbar must fit on one row on a 13" laptop, in both languages.
// It used to wrap: "←プロジェクト一覧" broke onto two lines, 写真 stacked one
// character per line, and the name chip shrank to "cri…". The everyday
// controls stay in the row; the occasional ones live behind the settings chip
// and "⋯".

test.use({ viewport: { width: 1366, height: 768 } });

/** Every toolbar control is a single line of text, and none spills out.
 *  Measured in one round trip: per-element calls are slow while WebGL draws. */
async function expectOneRow(page: Page) {
  const rows = await page.evaluate(() => {
    const bar = document.querySelector(".toolbar")!.getBoundingClientRect();
    const sel = ":scope > button, :scope > .tb-pop-root > button, :scope [role=group] > button";
    return [...document.querySelector(".toolbar")!.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: el.textContent?.trim() || el.getAttribute("aria-label") || "?",
          height: r.height,
          overflowRight: r.right - bar.right,
        };
      });
  });
  expect(rows.length).toBeGreaterThan(8);
  for (const r of rows) {
    // A wrapped label makes the button taller than one line of text.
    expect(r.height, `"${r.label}" wrapped`).toBeLessThanOrEqual(36);
    expect(r.overflowRight, `"${r.label}" is off the right edge`).toBeLessThanOrEqual(0.5);
  }
}

for (const lang of ["en", "ja"] as const) {
  test(`the editor toolbar fits on one row at 1366px (${lang})`, async ({ page, baseURL }) => {
    const project = `e2e-toolbar-${lang}-${Date.now()}`;
    const api = baseURL!;
    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });
      await page.addInitScript((l) => localStorage.setItem("ot.lang", l), lang);
      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();

      await expectOneRow(page);

      // Turning pin mode on must not re-wrap the row: its panel floats.
      await page.getByRole("button", { name: lang === "en" ? "More tools" : "その他のツール" }).click();
      await page.getByTestId("pin-mode").click();
      await expect(page.locator(".pin-add-panel")).toBeVisible();
      await expectOneRow(page);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
}

test("theme and language live behind the settings chip", async ({ page, baseURL }) => {
  const project = `e2e-settings-${Date.now()}`;
  const api = baseURL!;
  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "4f_default" },
    });
    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, project);

    await page.locator(".settings-chip").click();
    const panel = page.getByRole("dialog", { name: /Settings/ });
    await expect(panel).toBeVisible();

    await panel.getByRole("button", { name: "Light", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await panel.getByRole("button", { name: "日本語" }).click();
    await expect(page.getByRole("button", { name: "図を書き出す" })).toBeVisible();

    // Esc closes the panel and does not reach the editor behind it.
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-pop")).toHaveCount(0);
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`)
      .catch(() => undefined);
  }
});
