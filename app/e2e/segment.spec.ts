import { test, expect } from "@playwright/test";
import { loginIfNeeded, openProject } from "./helpers";

// Clicking a beam leg opens its editor (length, widths, shape). The editor is
// drawn through a drei <Html>, which renders into a React root of its own:
// anything it reads from app context must be re-provided there, or it crashes
// on open (the popover read useSettings() and got null).

let project = "";

test.afterEach(async ({ page, baseURL }) => {
  await page.request
    .post(`${baseURL}/api/projects/${project || "__none__"}/remove`)
    .catch(() => undefined);
});

test("clicking a beam leg opens its editor", async ({ page, baseURL }) => {
  project = `e2e-segment-${Date.now()}`;
  // A lone laser draws one long leg out to the board edge.
  await page.request.post(`${baseURL}/api/projects`, {
    data: { name: project, template: "from_laser", beamHeight: 100 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await loginIfNeeded(page);
  await openProject(page, project);
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1500);

  // No screen coordinates are exposed for 3D objects, so walk down the
  // canvas until a click lands on the leg's pick cylinder.
  const box = (await canvas.boundingBox())!;
  const popover = page.locator(".segment-popover");
  let opened = false;
  for (const fx of [0.5, 0.6, 0.4]) {
    for (let y = box.y + box.height * 0.2; y < box.y + box.height * 0.8; y += 4) {
      await page.mouse.click(box.x + box.width * fx, y);
      if (errors.length || (await popover.count())) { opened = true; break; }
    }
    if (opened) break;
  }

  expect(errors).toEqual([]);
  await expect(popover).toBeVisible();

  // And it edits: a shape preset is saved as the leg's widths.
  const widths = async () => {
    const data = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
    const leg = data.beam[0];
    return [leg.wIn, leg.wOut];
  };
  const [wIn, wOut] = await widths();
  expect(wOut).toBe(wIn);                    // a fresh leg is parallel
  await popover.getByRole("button", { name: /Expand|拡大/ }).click();
  await expect.poll(async () => {
    const [a, b] = await widths();
    return b > a;                            // expanding: opens out along the leg
  }).toBe(true);
  expect(errors).toEqual([]);
});
