import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import * as THREE from "three";

// Issue #114 / #115 / #116: PowerPoint-style grouping — Ctrl+click to
// multi-select, Ctrl+G to group, move the group as one rigid body, and find
// the group still there after a reload.

import { expandAllOutlinerTypes, loginIfNeeded, openProject } from "./helpers";

type Comp = { name: string; x: number; y: number; rotZ: number };

async function components(page: Page, baseURL: string, project: string): Promise<Comp[]> {
  const r = await page.request.get(`${baseURL}/api/projects/${project}`);
  const body = await r.json();
  return body.components as Comp[];
}

async function groups(page: Page, baseURL: string, project: string) {
  const r = await page.request.get(`${baseURL}/api/projects/${project}`);
  return (await r.json()).groups as { id: string; name: string; members: string[] }[];
}

test("group two parts, move them rigidly, and keep the group across a reload",
  async ({ page, baseURL }) => {
    const project = `e2e-group-${Date.now()}`;
    const api = baseURL!;

    try {
      // A bench with real parts on it — the blank template has none to group.
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
      const first = rows.nth(0);
      const second = rows.nth(1);
      const firstName = (await first.locator(".nm").innerText()).trim();
      const secondName = (await second.locator(".nm").innerText()).trim();

      // --- multi-select: plain click, then Ctrl+click ---
      await first.click();
      await second.click({ modifiers: ["Control"] });
      await expect(page.locator(".outliner .node.sel")).toHaveCount(2);
      // The Inspector switches to the group panel for a multi-selection.
      await expect(page.getByRole("button", { name: /Group \(Ctrl\+G\)|グループ化/ })).toBeVisible();

      // --- Ctrl+G ---
      const before = await components(page, api, project);
      await page.keyboard.press("Control+g");
      await expect(page.locator(".outliner .group-head")).toHaveCount(0);

      const saved = await groups(page, api, project);
      expect(saved).toHaveLength(1);
      expect(saved[0].members.sort()).toEqual([firstName, secondName].sort());

      // --- rigid move: arrow keys nudge every member by the same delta ---
      await page.locator("canvas").click({ position: { x: 5, y: 5 } });  // focus, no part
      await page.locator(".outliner").getByText(firstName, { exact: true }).click();
      await expect(page.locator(".outliner .node.sel")).toHaveCount(2);

      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");   // 1 mm each

      // Saves are debounced and fast presses coalesce, so wait for the move to
      // settle rather than assuming an exact number of millimetres landed.
      let last = Number.NaN;
      await expect.poll(async () => {
        const now = await components(page, api, project);
        const x = now.find((c) => c.name === firstName)!.x;
        const settled = x === last && x !== before.find((c) => c.name === firstName)!.x;
        last = x;
        return settled;
      }, { intervals: [400, 400, 400, 400, 400] }).toBe(true);

      const after = await components(page, api, project);
      const dx = (n: string) =>
        after.find((c) => c.name === n)!.x - before.find((c) => c.name === n)!.x;
      expect(dx(firstName)).toBe(dx(secondName));   // moved together
      expect(dx(firstName)).not.toBe(0);
      // Parts outside the group stayed put.
      for (const c of before) {
        if (c.name !== firstName && c.name !== secondName) {
          expect(after.find((a) => a.name === c.name)!.x).toBe(c.x);
        }
      }

      // --- persistence: reload and reopen ---
      await page.reload();
      await loginIfNeeded(page);
      await openProject(page, project);
      await expandAllOutlinerTypes(page);
      await expect(page.locator(".outliner .group-head")).toHaveCount(0);

      // --- drill in and step back out ---
      const firstMember = page.locator(".outliner").getByText(firstName, { exact: true });
      await firstMember.dblclick();
      await expect(page.locator(".outliner .node.sel")).toHaveCount(1);  // one member
      // Clicking a part outside the group leaves it, so the group selects
      // whole again on the next click.
      await page.locator(".outliner .node").last().click();
      await firstMember.click();
      await expect(page.locator(".outliner .node.sel")).toHaveCount(2);

      // --- ungroup ---
      await firstMember.click();
      await page.keyboard.press("Control+Shift+G");
      await expect(page.locator(".outliner .group-head")).toHaveCount(0);
      expect(await groups(page, api, project)).toEqual([]);
      // Ungrouping must not move anything.
      const finalComps = await components(page, api, project);
      expect(finalComps.find((c) => c.name === firstName)!.x)
        .toBe(after.find((c) => c.name === firstName)!.x);
    } finally {
      await page.request.post(`${baseURL}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });

test("rotating a group turns it about its own centroid, rigidly",
  async ({ page, baseURL }) => {
    const project = `e2e-rot-${Date.now()}`;
    const api = baseURL!;
    // Three parts in a row on the optical axis: after +90° they should end up
    // stacked along Y, all with the same rotZ advance and the same spacing.
    const wanted = ["Beamsplitter", "ImagingLens", "FourierFilter"];

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
      let first = true;
      for (let i = 0, n = await rows.count(); i < n; i++) {
        const name = (await rows.nth(i).locator(".nm").innerText()).trim();
        if (!wanted.includes(name)) continue;
        await rows.nth(i).click(first ? {} : { modifiers: ["Control"] });
        first = false;
      }
      await page.keyboard.press("Control+g");
      await expect(page.locator(".outliner .group-head")).toHaveCount(0);

      const before = await components(page, api, project);
      const picked = before.filter((c) => wanted.includes(c.name));
      const px = picked.reduce((s, c) => s + c.x, 0) / picked.length;
      const py = picked.reduce((s, c) => s + c.y, 0) / picked.length;

      // Rot Z +15 six times = 90°, through the Inspector's group nudges.
      const rotPlus = page.locator(".fieldgrid .field", { hasText: "Rot Z" })
        .getByRole("button", { name: "+15" });
      for (let i = 0; i < 6; i++) await rotPlus.click();

      await expect.poll(async () => {
        const now = await components(page, api, project);
        return now.find((c) => c.name === wanted[0])!.rotZ;
      }).toBe(before.find((c) => c.name === wanted[0])!.rotZ + 90);

      const after = await components(page, api, project);
      const get = (list: Comp[], name: string) => list.find((c) => c.name === name)!;

      for (const name of wanted) {
        const b = get(before, name);
        const a = get(after, name);
        // (x, y) rotated +90° about the centroid, to within mm rounding
        expect(Math.abs(a.x - (px - (b.y - py)))).toBeLessThanOrEqual(1);
        expect(Math.abs(a.y - (py + (b.x - px)))).toBeLessThanOrEqual(1);
        expect(a.rotZ).toBe(b.rotZ + 90);
      }

      // A rigid rotation preserves every pairwise distance.
      const dist = (list: Comp[], p: string, q: string) =>
        Math.hypot(get(list, p).x - get(list, q).x, get(list, p).y - get(list, q).y);
      for (const [p, q] of [[0, 1], [1, 2], [0, 2]] as const) {
        expect(dist(after, wanted[p], wanted[q]))
          .toBeCloseTo(dist(before, wanted[p], wanted[q]), 0);
      }

      for (const b of before) {
        if (wanted.includes(b.name)) continue;
        const a = get(after, b.name);
        expect([a.x, a.y, a.rotZ]).toEqual([b.x, b.y, b.rotZ]);
      }
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });

test("dragging the group gizmo translates every member and nothing else",
  async ({ page, baseURL }) => {
    const project = `e2e-gizmo-${Date.now()}`;
    const api = baseURL!;
    const wanted = ["Beamsplitter", "SLM", "Polarizer"];

    try {
      await page.request.post(`${api}/api/projects`, {
        data: { name: project, template: "4f_default" },
      });
      await page.goto("/");
      await loginIfNeeded(page);
      await openProject(page, project);
      await expect(page.locator("canvas")).toBeVisible();
      await expandAllOutlinerTypes(page);
      // This test projects world coordinates through a rebuilt copy of the
      // viewport camera, so it needs the canvas at its final size and the
      // renderer past its first frame. The Snapshot button is enabled by
      // exactly that signal (Viewport's onReady), so wait on it.
      await expect(page.getByRole("button", { name: /Snapshot|スナップショット/ }))
        .toBeEnabled();

      const rows = page.locator(".outliner .node");
      await expect(rows.first()).toBeVisible();
      let first = true;
      for (let i = 0, n = await rows.count(); i < n; i++) {
        const name = (await rows.nth(i).locator(".nm").innerText()).trim();
        if (!wanted.includes(name)) continue;
        await rows.nth(i).click(first ? {} : { modifiers: ["Control"] });
        first = false;
      }
      await page.keyboard.press("Control+g");
      await expect(page.locator(".outliner .group-head")).toHaveCount(0);

      const data = await (await page.request.get(`${api}/api/projects/${project}`)).json();
      const before: Comp[] = data.components;
      const picked = before.filter((c) => wanted.includes(c.name));
      const pivot = {
        x: picked.reduce((s, c) => s + c.x, 0) / picked.length,
        y: picked.reduce((s, c) => s + c.y, 0) / picked.length,
        z: Math.min(...picked.map((c) => (c as any).z)),
      };

      // The gizmo sits at the selection's pivot. Rebuilding the viewport camera
      // exactly as Viewport.tsx sets it up projects that pivot to screen space,
      // so the drag can grab a real handle instead of hunting pixels.
      const bb = data.board.bbox;
      const box = (await page.locator("canvas").boundingBox())!;
      const cx = (bb.min[0] + bb.max[0]) / 2;
      const cy = (bb.min[1] + bb.max[1]) / 2;
      const span = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) || 400;
      const cam = new THREE.PerspectiveCamera(35, box.width / box.height, 1, span * 12);
      cam.up.set(0, 0, 1);
      cam.position.set(cx, cy - span, span * 0.85);
      cam.lookAt(new THREE.Vector3(cx, cy, 0));
      cam.updateMatrixWorld(true);

      const toScreen = (v: THREE.Vector3) => {
        const p = v.clone().project(cam);
        return {
          x: box.x + (p.x * 0.5 + 0.5) * box.width,
          y: box.y + (-p.y * 0.5 + 0.5) * box.height,
        };
      };
      const origin = toScreen(new THREE.Vector3(pivot.x, pivot.y, pivot.z));
      const alongX = toScreen(new THREE.Vector3(pivot.x + 100, pivot.y, pivot.z));
      const dir = { x: alongX.x - origin.x, y: alongX.y - origin.y };
      const len = Math.hypot(dir.x, dir.y);
      const ux = dir.x / len;
      const uy = dir.y / len;

      // Grab the +X arrow ~45 px out from the pivot and drag it 90 px further.
      await page.mouse.move(origin.x + ux * 45, origin.y + uy * 45);
      await page.mouse.down();
      await page.mouse.move(origin.x + ux * 135, origin.y + uy * 135, { steps: 25 });
      await page.mouse.up();

      await expect.poll(async () => {
        const now = await components(page, api, project);
        return now.find((c) => c.name === wanted[0])!.x;
      }).not.toBe(before.find((c) => c.name === wanted[0])!.x);

      const after = await components(page, api, project);
      const delta = (n: string) =>
        after.find((c) => c.name === n)!.x - before.find((c) => c.name === n)!.x;

      // Every member translated by the same amount along X only...
      const dx = delta(wanted[0]);
      expect(dx).toBeGreaterThan(0);
      for (const name of wanted) {
        expect(delta(name)).toBe(dx);
        const b = before.find((c) => c.name === name)!;
        const a = after.find((c) => c.name === name)!;
        expect(a.y).toBe(b.y);
        expect(a.rotZ).toBe(b.rotZ);
      }
      // ...and no part outside the group moved at all.
      for (const b of before) {
        if (wanted.includes(b.name)) continue;
        const a = after.find((c) => c.name === b.name)!;
        expect([a.x, a.y, a.rotZ]).toEqual([b.x, b.y, b.rotZ]);
      }
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });

test("the group outline shows only while the group is selected",
  async ({ page, baseURL }) => {
    const project = `e2e-outline-${Date.now()}`;
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
      await rows.nth(0).click();
      await rows.nth(1).click({ modifiers: ["Control"] });
      await page.keyboard.press("Control+g");
      await expect(page.locator(".outliner .group-head")).toHaveCount(0);

      // The dashed box is WebGL and can't be asserted on, but its name label is
      // a drei <Html> overlay in the DOM that mounts and unmounts with it — so
      // the label stands in for the whole outline here.
      const label = page.locator(".group-label");
      await expect(label).toHaveCount(1);

      // Deselecting must leave the viewport clean: no box for an idle group.
      await page.keyboard.press("Escape");
      await expect(page.locator(".outliner .node.sel")).toHaveCount(0);
      await expect(label).toHaveCount(0);

      // ...and selecting the group brings it back.
      await rows.nth(0).click();
      await expect(label).toHaveCount(1);
    } finally {
      await page.request.post(`${api}/api/projects/${project}/remove`)
        .catch(() => undefined);
    }
  });
