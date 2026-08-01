import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Issue #157: Ctrl+Z rewinds an editing step, Ctrl+Shift+Z replays it. The
// history is a stack of USD layer snapshots on the server, so a delete comes
// back with its reference and attributes intact.

import { loginIfNeeded, openProject } from "./helpers";

type Comp = { name: string; x: number; y: number; type: string };

async function components(page: Page, baseURL: string, project: string): Promise<Comp[]> {
  const r = await page.request.get(`${baseURL}/api/projects/${project}`);
  return (await r.json()).components as Comp[];
}

const nameOf = (c: Comp) => c.name;

test("Ctrl+Z rewinds an edit and Ctrl+Shift+Z replays it",
  async ({ page, baseURL }) => {
    const project = `e2e-undo-${Date.now()}`;
    const api = baseURL!;

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });

      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();

      const rows = page.locator(".outliner .node");
      await expect(rows.first()).toBeVisible();
      const before = await components(page, api, project);
      const undoBtn = page.getByRole("button", { name: /^(Undo|元に戻す)$/ });
      const redoBtn = page.getByRole("button", { name: /^(Redo|やり直す)$/ });

      // Nothing has happened yet, so there is nothing to rewind.
      await expect(undoBtn).toBeDisabled();
      await expect(redoBtn).toBeDisabled();

      // --- an edit: delete the selected part ---
      const victim = (await rows.nth(0).locator(".nm").innerText()).trim();
      await rows.nth(0).click();
      page.once("dialog", (d) => d.accept());          // the remove confirmation
      await page.keyboard.press("Delete");
      await expect(rows).toHaveCount(before.length - 1);
      await expect(undoBtn).toBeEnabled();

      // --- Ctrl+Z: the part comes back, intact ---
      await page.keyboard.press("Control+z");
      await expect(rows).toHaveCount(before.length);

      const restored = await components(page, api, project);
      expect(restored.map(nameOf).sort()).toEqual(before.map(nameOf).sort());
      const was = before.find((c) => c.name === victim)!;
      const now = restored.find((c) => c.name === victim)!;
      expect([now.x, now.y, now.type]).toEqual([was.x, was.y, was.type]);

      // --- Ctrl+Shift+Z: gone again ---
      await expect(redoBtn).toBeEnabled();
      await page.keyboard.press("Control+Shift+z");
      await expect(rows).toHaveCount(before.length - 1);

      await page.keyboard.press("Control+z");
      await expect(rows).toHaveCount(before.length);

      // --- Ctrl+Y is the other conventional redo binding ---
      await page.keyboard.press("Control+y");
      await expect(rows).toHaveCount(before.length - 1);

      // Put it back so the project ends as it started.
      await page.keyboard.press("Control+z");
      await expect(rows).toHaveCount(before.length);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });

test("repeated undo walks all the way back to the starting layout",
  async ({ page, baseURL }) => {
    const project = `e2e-undo-walk-${Date.now()}`;
    const api = baseURL!;

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });

      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();

      const rows = page.locator(".outliner .node");
      await expect(rows.first()).toBeVisible();
      const target = (await rows.nth(0).locator(".nm").innerText()).trim();
      const startX = (await components(page, api, project))
        .find((c) => c.name === target)!.x;

      await rows.nth(0).click();
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");

      // Saves are debounced, so wait for the move to reach USD before undoing.
      await expect.poll(async () => {
        const c = (await components(page, api, project)).find((x) => x.name === target)!;
        return c.x !== startX;
      }, { intervals: [300, 300, 400, 500, 700] }).toBe(true);

      // Nudges land as one or more steps depending on how they fall against
      // the 300 ms debounce, so rewind until the stack is empty. However many
      // steps it took, the part must end up exactly where it started — no
      // drift, no half-applied move.
      // Requests are chained client-side, so pressing more times than there
      // are steps is harmless — the extras are no-ops on an empty stack.
      const undoBtn = page.getByRole("button", { name: /^(Undo|元に戻す)$/ });
      for (let i = 0; i < 12; i++) await page.keyboard.press("Control+z");
      await expect(undoBtn).toBeDisabled();

      const back = (await components(page, api, project))
        .find((c) => c.name === target)!;
      expect(back.x).toBe(startX);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
