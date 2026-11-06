import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { loginIfNeeded, openProject } from "./helpers";

// A pin deleted from the keyboard must stay deleted. The Delete key used to
// remove the pin from the screen without saving, so it came back on reload,
// while the pin's own Delete button saved correctly.

const PIN = {
  id: "e2e-pin",
  label: "Check this mount",
  x: 0,
  y: 0,
  z: 0,
  authorName: "e2e",
  color: "#4c8dff",
  size: 1,
  createdAt: "2026-11-06T00:00:00.000Z",
};

/**
 * Select the pin by clicking its head in the 3D view. A pin is selected by a
 * raycast on its meshes, not by its HTML label, but the label floats just above
 * the head, so the head is found a little below the label's box.
 */
async function selectPin(page: Page) {
  const label = page.locator(".pin-label").first();
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;
  const x = box.x + box.width / 2;
  for (const below of [6, 12, 18, 26, 36, 48, 62]) {
    await page.mouse.click(x, box.y + box.height + below);
    if (await page.locator(".pin-label.selected").count()) return;
  }
  throw new Error("could not click the pin head below its label");
}

async function savedPins(page: Page, api: string, project: string) {
  const r = await page.request.get(`${api}/api/projects/${project}?renderMode=lo`);
  return ((await r.json()).pins ?? []) as { id: string }[];
}

test("deleting a selected pin with the Delete key is saved", async ({ page, baseURL }) => {
  const project = `e2e-pins-${Date.now()}`;
  const api = baseURL!;

  try {
    await page.request.post(`${api}/api/projects`, {
      data: { name: project, template: "blank" },
    });
    await page.request.post(`${api}/api/projects/${project}/pins`, {
      data: { pins: [PIN] },
    });
    expect(await savedPins(page, api, project)).toHaveLength(1);

    await page.goto("/");
    await loginIfNeeded(page);
    await openProject(page, project);
    await expect(page.locator("canvas")).toBeVisible();

    await selectPin(page);
    page.once("dialog", (dialog) => dialog.accept());   // "Delete this pin?"
    await page.keyboard.press("Delete");
    await expect(page.locator(".pin-label")).toHaveCount(0);

    // Gone on the server, not only on the screen: a reload must not bring it back.
    await expect.poll(async () => (await savedPins(page, api, project)).length).toBe(0);
  } finally {
    await page.request.post(`${api}/api/projects/${project}/remove`);
  }
});
