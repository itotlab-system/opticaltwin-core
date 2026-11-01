import { test, expect } from "@playwright/test";

// Beam-first building: a new design starts from a laser, optics land in its
// beam, and a mirror's fold is picked by clicking where the beam should go.

import { loginIfNeeded, openProject } from "./helpers";

let project = "";

test.afterEach(async ({ page, baseURL }) => {
  await page.request
    .post(`${baseURL}/api/projects/${project || "__none__"}/remove`)
    .catch(() => undefined);
});

test("a new design starts from a laser at the chosen beam height", async ({ page, baseURL }) => {
  project = `e2e-beamfirst-${Date.now()}`;
  await page.goto("/");
  await loginIfNeeded(page);

  await page.getByTestId("new-project-tile").click();
  await page.locator(".newform input").first().fill(project);
  // It is the default way in, and its two choices appear with it.
  await expect(page.getByTestId("new-template")).toHaveValue("from_laser");
  await expect(page.getByTestId("new-laser")).toBeVisible();
  await page.getByTestId("new-beam-height").fill("75");
  await page.locator(".newform button.primary").click();
  await page.locator(".outliner").waitFor();

  const data = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
  expect(data.components.map((c: { type: string }) => c.type)).toEqual(["laser"]);
  expect(data.beam[0].pts[0][2]).toBeCloseTo(75, 3);
});

test("the fold targets turn a mirror to send the beam that way", async ({ page, baseURL }) => {
  project = `e2e-beamfirst-${Date.now()}`;
  await page.request.post(`${baseURL}/api/projects`, {
    data: { name: project, template: "from_laser", beamHeight: 100 },
  });
  // Dropped near the beam, so it lands in it already folding to the left.
  const added = await (await page.request.post(`${baseURL}/api/projects/${project}/add`, {
    data: { asset: "Mirror/BBSQ2-E02-Step.usda", x: 100, y: 10 },
  })).json();
  expect(added.snapped).toBeTruthy();

  await page.goto("/");
  await loginIfNeeded(page);
  await openProject(page, project);
  await expect(page.locator("canvas")).toBeVisible();
  await page.locator(".outliner").getByText(added.name, { exact: true }).click();

  const current = page.locator(".fold-target.current");
  const other = page.locator(".fold-target:not(.current)");
  await expect(current).toHaveCount(1);
  await expect(other).toHaveCount(1);
  const leavingY = async () => {
    const data = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
    const leg = data.beam.find((b: { from: string }) => b.from === added.name);
    return Math.sign(leg.pts[1][1] - leg.pts[0][1]);
  };
  expect(await leavingY()).toBe(1);

  await other.click();
  await expect.poll(leavingY).toBe(-1);
  // The target just used is now the current one.
  await expect(page.locator(".fold-target.current")).toHaveCount(1);
});

test("the tile at the end of the gallery opens the new-project form", async ({ page }) => {
  project = "";
  await page.goto("/");
  await loginIfNeeded(page);
  const tile = page.getByTestId("new-project-tile");
  await tile.click();
  await expect(page.locator(".newform")).toBeVisible();
  await expect(page.locator(".newform input").first()).toBeFocused();
  // While the form is open the tile steps aside; Cancel brings it back.
  await expect(tile).toHaveCount(0);
  await page.getByTestId("new-cancel").click();
  await expect(page.locator(".newform")).toHaveCount(0);
  await expect(tile).toBeVisible();
});
