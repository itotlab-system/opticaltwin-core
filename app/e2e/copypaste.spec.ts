import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Issue #155: copy & paste. Ctrl+C / Ctrl+V duplicates the selected parts one
// breadboard hole away, repeated pastes fan out, and a whole project can be
// duplicated from its gallery card.

import { expandAllOutlinerTypes, loginIfNeeded, openProject } from "./helpers";

type Comp = { name: string; x: number; y: number; z: number; rotZ: number };

async function components(page: Page, baseURL: string, project: string): Promise<Comp[]> {
  const r = await page.request.get(`${baseURL}/api/projects/${project}`);
  return (await r.json()).components as Comp[];
}

test("Ctrl+C / Ctrl+V drops a copy one hole away, and pastes again fan out",
  async ({ page, baseURL }) => {
    const project = `e2e-copy-${Date.now()}`;
    const api = baseURL!;

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });

      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();
      await expandAllOutlinerTypes(page);

      const rows = page.locator(".outliner .node");
      await expect(rows.first()).toBeVisible();
      const before = await components(page, api, project);
      const source = (await rows.nth(0).locator(".nm").innerText()).trim();
      const origin = before.find((c) => c.name === source)!;

      await rows.nth(0).click();
      await expect(page.locator(".outliner .node.sel")).toHaveCount(1);

      // --- copy, then paste ---
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
      await expect(rows).toHaveCount(before.length + 1);

      const afterOne = await components(page, api, project);
      const first = afterOne.find((c) => !before.some((b) => b.name === c.name))!;
      expect(first.name).toBe(`${source}_2`);
      expect(first.x).toBe(origin.x + 25);       // one 25 mm hole, diagonally
      expect(first.y).toBe(origin.y + 25);
      expect(first.z).toBe(origin.z);            // height and pose carried over
      expect(first.rotZ).toBe(origin.rotZ);
      // The original stayed where it was.
      expect(afterOne.find((c) => c.name === source)!.x).toBe(origin.x);

      // The copy is what's selected now, ready to be dragged off.
      await expect(page.locator(".outliner .node.sel")).toHaveCount(1);

      // --- paste again: the next copy steps one more hole out ---
      await page.keyboard.press("Control+v");
      await expect(rows).toHaveCount(before.length + 2);

      const afterTwo = await components(page, api, project);
      const second = afterTwo.find(
        (c) => c.name !== first.name && !before.some((b) => b.name === c.name),
      )!;
      expect(second.x).toBe(origin.x + 50);
      expect(second.y).toBe(origin.y + 50);

      // --- Ctrl+D duplicates the selection in one keystroke ---
      await rows.nth(0).click();
      await page.keyboard.press("Control+d");
      await expect(rows).toHaveCount(before.length + 3);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });

test("a copy taken in one project pastes into another", async ({ page, baseURL }) => {
  // Issue #155: the clipboard outlives leaving the project, and the parts land
  // on the coordinates they had on the other bench.
  const stamp = Date.now();
  const source = `e2e-xsrc-${stamp}`;
  const target = `e2e-xdst-${stamp}`;
  const api = baseURL!;

  try {
    for (const name of [source, target]) {
      await page.request.post(`${api}/api/projects`, {
        data: { name, template: "4f_default" },
      });
    }

    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, source);
    await expect(page.locator("canvas")).toBeVisible();
    await expandAllOutlinerTypes(page);

    const rows = page.locator(".outliner .node");
    await expect(rows.first()).toBeVisible();
    const copied = (await rows.nth(0).locator(".nm").innerText()).trim();
    const sourceBefore = await components(page, api, source);
    const origin = sourceBefore.find((c) => c.name === copied)!;

    await rows.nth(0).click();
    await page.keyboard.press("Control+c");

    // Back to the gallery and into the other project — the clipboard survives.
    await page.locator(".backbtn").click();
    await openProject(page, target);
    await expect(page.locator("canvas")).toBeVisible();
    await expandAllOutlinerTypes(page);
    const before = await components(page, api, target);

    await page.keyboard.press("Control+v");
    await expect(rows).toHaveCount(before.length + 1);

    const after = await components(page, api, target);
    const pasted = after.find((c) => !before.some((b) => b.name === c.name))!;
    expect(pasted.x).toBe(origin.x);           // same spot on the other bench
    expect(pasted.y).toBe(origin.y);
    expect(pasted.z).toBe(origin.z);
    expect(pasted.rotZ).toBe(origin.rotZ);

    // Nothing moved or multiplied in the project it was copied from.
    const sourceAfter = await components(page, api, source);
    expect(sourceAfter).toHaveLength(sourceBefore.length);
    expect(sourceAfter.find((c) => c.name === copied)!.x).toBe(origin.x);
  } finally {
    for (const name of [source, target]) {
      await page.request.post(`${api}/api/projects/${name}/remove`)
        .catch(() => undefined);
    }
  }
});

test("the gallery card duplicates a whole project", async ({ page, baseURL }) => {
  const project = `e2e-dup-${Date.now()}`;
  const copy = `${project}_copy`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "4f_default" },
    });

    await page.goto("/");
    await loginIfNeeded(page);

    const card = page.locator(".card", { hasText: project }).first();
    await expect(card).toBeVisible();
    await card.locator(".card-dup").click();

    await expect(page.locator(".card", { hasText: copy })).toBeVisible();

    // Same parts in the same places, but an independent setup.
    const original = await components(page, api, project);
    const duplicated = await components(page, api, copy);
    expect(duplicated.map((c) => [c.name, c.x, c.y]))
      .toEqual(original.map((c) => [c.name, c.x, c.y]));

    await page.request.post(`${api}/api/projects/${copy}/components/duplicate`, {
      data: { names: [original[0].name] },
    });
    expect(await components(page, api, project)).toHaveLength(original.length);
  } finally {
    for (const name of [copy, project]) {
      await page.request.post(`${api}/api/projects/${name}/remove`)
        .catch(() => undefined);
    }
  }
});
