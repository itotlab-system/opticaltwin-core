import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Build a bench from a photo: upload, calibrate on four holes, mark parts at
// their feet, build. The photo is drawn by the test -- a top-down board with
// holes on a known pixel grid -- so every click lands on a hole it can name.

import { loginIfNeeded, openProject } from "./helpers";

let project = "";
// Hole (col, row) -> photo pixel. Row 1 is the near edge, at the bottom.
const px = (col: number) => 50 + (col - 1) * 20;
const py = (row: number) => 550 - (row - 1) * 20;

async function syntheticPhoto(page: Page, cols: number, rows: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(([cols, rows]) => {
    const c = document.createElement("canvas");
    c.width = 600; c.height = 600;
    const g = c.getContext("2d")!;
    g.fillStyle = "#b8bcc2"; g.fillRect(0, 0, 600, 600);
    g.fillStyle = "#222";
    for (let i = 1; i <= cols; i++) {
      for (let j = 1; j <= rows; j++) {
        g.beginPath(); g.arc(50 + (i - 1) * 20, 550 - (j - 1) * 20, 3, 0, Math.PI * 2); g.fill();
      }
    }
    return c.toDataURL("image/jpeg", 0.9);
  }, [cols, rows]);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function clickPhoto(page: Page, x: number, y: number, to?: [number, number]) {
  const screen = (x: number, y: number) => page.evaluate(([x, y]) => {
    const svg = document.querySelector("[data-testid=photo-svg]") as SVGSVGElement;
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
    const s = pt.matrixTransform(svg.getScreenCTM()!);
    return [s.x, s.y];
  }, [x, y]);
  const [sx, sy] = await screen(x, y);
  if (!to) { await page.mouse.click(sx, sy); return; }
  const [tx, ty] = await screen(...to);
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 6 }); await page.mouse.up();
}

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/projects/${project}/remove`).catch(() => undefined);
});

test("a bench marked on a photo is built with its beam traced", async ({ page, baseURL }) => {
  project = `e2e-photo-${Date.now()}`;
  await page.request.post(`${baseURL}/api/projects`, { data: { name: project, template: "blank" } });
  const data = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
  const holes: [number, number][] = data.board.holes;
  const cols = new Set(holes.map((h) => Math.round(h[0]))).size;
  const rows = new Set(holes.map((h) => Math.round(h[1]))).size;

  await page.goto("/");
  await loginIfNeeded(page);
  await openProject(page, project);
  await page.getByTestId("open-photo").click();
  await page.getByTestId("photo-file").setInputFiles({
    name: "bench.jpg", mimeType: "image/jpeg", buffer: await syntheticPhoto(page, cols, rows),
  });
  await expect(page.getByTestId("photo-svg")).toBeVisible();

  // Calibrate on the four corners, in a jumbled order: which is which comes
  // from where they sit in the photo.
  await expect(page.getByTestId("photo-banner")).toContainText(/1 \/ 4/);
  for (const [c, r] of [[cols, rows], [1, 1], [1, rows], [cols, 1]]) {
    await clickPhoto(page, px(c), py(r));
  }
  // The predicted grid is drawn: one dot per hole.
  await expect(page.locator(".photo-hole")).toHaveCount(holes.length);
  await page.getByTestId("photo-banner").getByRole("button", { name: /Next|次へ/ }).click();

  // ② Draw the beam: from the laser output, a corner, then up the board.
  // Clicks are a little crooked; the legs come out square.
  const mid = Math.round(rows / 2);
  await expect(page.getByTestId("photo-banner")).toContainText(/laser|レーザー/i);
  await clickPhoto(page, px(3), py(mid));
  await clickPhoto(page, px(15), py(mid) + 3);
  await clickPhoto(page, px(15) - 2, py(mid + 8));
  await page.keyboard.press("Enter");
  // A branch, started on the beam: a splitter's second arm, toward the near side.
  await clickPhoto(page, px(9) + 2, py(mid) - 2);
  await clickPhoto(page, px(9), py(mid - 6));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("photo-path-summary")).toContainText(/2/);
  await expect(page.getByTestId("photo-beam")).toHaveCount(2);
  await page.getByTestId("photo-next-parts").click();

  // Marking a foot opens the picture catalogue straight away.
  const pick = async (query: string) => {
    const browser = page.locator(".part-browser");
    await expect(browser).toBeVisible();
    await browser.locator(".part-search").fill(query);
    await browser.locator(".part-tile").first().click();
    await expect(browser).toBeHidden();
  };

  // ③ Parts, in any order, clicked near (not on) the beam. Nobody marks the
  // laser, the corner mirror or the splitter: the drawing supplies them.
  await clickPhoto(page, px(15) + 4, py(mid + 6));
  await pick("Cam-44");
  await clickPhoto(page, px(6), py(mid) + 5);
  await pick("LA1417");
  await clickPhoto(page, px(9) - 3, py(mid - 4));
  await pick("Cam-44");
  // A post the beam does not pass through.
  await page.getByTestId("photo-offbeam").click();
  await clickPhoto(page, px(5), py(3));
  await pick("TR75");

  await page.getByTestId("photo-build").click();
  await expect(page.locator(".photo-msg")).toContainText(/7/);

  const built = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
  const typeOf = new Map<string, string>(
    built.components.map((c: { name: string; type: string }) => [c.name, c.type]));
  const types = [...typeOf.values()].sort();
  expect(types).toEqual(["beamsplitter", "camera", "camera", "laser", "lens", "mirror", "post"]);
  // The built beam follows the drawing: laser -> lens -> splitter, which
  // sends one arm to a camera and the other round the corner mirror to the other.
  const legs = built.beam
    .filter((b: { to: string | null }) => b.to)
    .map((b: { from: string; to: string }) => `${typeOf.get(b.from)}>${typeOf.get(b.to)}`);
  expect(legs).toEqual(expect.arrayContaining([
    "laser>lens", "lens>beamsplitter", "beamsplitter>camera",
    "beamsplitter>mirror", "mirror>camera",
  ]));
  for (const c of built.components) {
    if (c.type !== "post") expect(c.rotZ % 45).toBeCloseTo(0, 5);   // all square
  }

  // What was marked survives a reopen.
  await page.getByTestId("photo-close").click();
  await page.getByTestId("open-photo").click();
  await page.getByTestId("photo-tab-parts").click();
  await expect(page.locator(".photo-part-list li")).toHaveCount(4);
});
