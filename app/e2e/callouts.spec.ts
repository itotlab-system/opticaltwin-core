import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Figure callouts: label a part for a paper figure, retype the label in the
// venue's own words, and get it into the exported picture.

import { expandAllOutlinerTypes, loginIfNeeded, openProject } from "./helpers";

async function callouts(page: Page, baseURL: string, project: string) {
  const r = await page.request.get(`${baseURL}/api/projects/${project}`);
  return (await r.json()).callouts as
    { id: string; target: string; text: string; dx: number; dy: number }[];
}

test("label a part, retype the label, and export it into the figure",
  async ({ page, baseURL }) => {
    // The bench renders 37 CAD parts under swiftshader, twice (once after the
    // reload), and the run ends with a 2x export — comfortably past the 60 s
    // default even when nothing is wrong.
    test.setTimeout(180_000);
    const project = `e2e-callout-${Date.now()}`;
    const api = baseURL!;

    try {
      // A bench with real parts on it — the blank template has none to label.
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });

      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();
      await expandAllOutlinerTypes(page);

      // A part from the middle of the list, not the first one: the outliner
      // lists the bench in beam order, so the first row is the laser at one end
      // of the board, and a label pinned to a part that far out lands under the
      // inspector panel where it cannot be double-clicked. Which part carries
      // the label is not what this test is about.
      const rows = page.locator(".outliner .node");
      await expect(rows.first()).toBeVisible();
      const first = rows.nth(Math.floor((await rows.count()) / 2));
      const partName = (await first.locator(".nm").innerText()).trim();

      // --- label it ---
      await page.getByRole("button", { name: "図注", exact: true }).click();
      await first.click();
      await expect(page.locator(".callout-item")).toHaveCount(1);

      const saved = await callouts(page, api, project);
      expect(saved).toHaveLength(1);
      expect(saved[0].target).toBe(partName);
      // The label starts out saying what the part is — a first guess, not a
      // binding.
      expect(saved[0].text.length).toBeGreaterThan(0);

      // --- retype it: the whole point is that a paper picks its own words ---
      await page.locator(".callout-hit").dblclick();
      const editor = page.locator(".callout-editor");
      await expect(editor).toBeVisible();
      await editor.fill("位相変調素子");
      await editor.press("Enter");

      await expect
        .poll(async () => (await callouts(page, api, project))[0].text)
        .toBe("位相変調素子");
      await expect(page.locator(".callout-item text").first()).toHaveText("位相変調素子");

      // --- move the point the leader line lands on ---
      // The dot starts at the part's origin; its grab handle appears once the
      // label is selected. Dragging it resolves a point on the part itself,
      // stored in the part's own frame.
      await page.locator(".callout-hit").click();
      const grip = page.locator(".callout-grip");
      await expect(grip).toBeVisible();
      const box = (await grip.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10,
                            { steps: 8 });
      await page.mouse.up();

      await expect
        .poll(async () => {
          const c = (await callouts(page, api, project))[0] as
            Record<string, number | string>;
          return typeof c.ax === "number" && typeof c.ay === "number"
            && typeof c.az === "number";
        })
        .toBe(true);

      // --- and it survives a reload, because it lives in the USD layer ---
      await page.reload();
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator(".callout-item")).toHaveCount(1);

      // --- export: the SVG carries the label as real text ---
      await page.getByRole("button", { name: "Snapshot" }).click();
      await page.locator(".figure-export-row select").first()
        .selectOption("svg");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "書き出す" }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.svg$/);

      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const svg = Buffer.concat(chunks).toString("utf8");
      expect(svg).toContain("位相変調素子");
      expect(svg).toContain("<image");          // the bench itself, embedded
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
