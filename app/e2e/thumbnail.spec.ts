import { test, expect } from "@playwright/test";
import { loginIfNeeded, openProject } from "./helpers";

// The gallery card shows a saved picture of the bench, taken from the editor,
// instead of every viewer's browser rendering every bench.

let project = "";

test.afterEach(async ({ page, baseURL }) => {
  await page.request
    .post(`${baseURL}/api/projects/${project || "__none__"}/remove`)
    .catch(() => undefined);
});

test("a saved view becomes the gallery picture, outdated after an edit", async ({ page, baseURL }) => {
  project = `e2e-thumb-${Date.now()}`;
  await page.request.post(`${baseURL}/api/projects`, {
    data: { name: project, template: "from_laser", beamHeight: 100 },
  });

  await page.goto("/");
  await loginIfNeeded(page);
  await openProject(page, project);
  await expect(page.locator("canvas")).toBeVisible();

  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Export figure|図を書き出す|書き出し/ }).click();
  const save = page.getByTestId("use-as-thumbnail");
  await expect(save).toBeEnabled();
  await save.click();
  // The sheet closes once it is saved (slow under software-rendered WebGL).
  await expect(save).toHaveCount(0, { timeout: 30_000 });

  const summary = async () => {
    const list = await (await page.request.get(`${baseURL}/api/projects`)).json();
    return list.projects.find((p: { name: string }) => p.name === project).thumbnail;
  };
  await expect.poll(async () => (await summary())?.current).toBe(true);

  // Back in the gallery, the card shows that file, at the card's size.
  await page.getByRole("button", { name: /Projects|プロジェクト一覧/ }).click();
  const card = page.locator(".card", { hasText: project }).first();
  const img = card.getByTestId("card-thumbnail");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(480);
  await expect(card.locator(".card-thumb-outdated")).toHaveCount(0);

  // An edit since the picture was taken marks it outdated (still shown).
  const data = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
  const laser = data.components[0].name;
  await page.request.post(`${baseURL}/api/projects/${project}/components/${laser}`, {
    data: { x: data.components[0].x + 25 },
  });
  await page.reload();
  await loginIfNeeded(page);
  const again = page.locator(".card", { hasText: project }).first();
  await expect(again.getByTestId("card-thumbnail")).toBeVisible();
  await expect(again.locator(".card-thumb-outdated")).toBeVisible();
});

test("leaving a bench refreshes its picture when it is missing or outdated", async ({ page, baseURL }) => {
  project = `e2e-thumb-auto-${Date.now()}`;
  await page.request.post(`${baseURL}/api/projects`, {
    data: { name: project, template: "from_laser", beamHeight: 100 },
  });
  const card = async () => {
    const list = await (await page.request.get(`${baseURL}/api/projects`)).json();
    return list.projects.find((p: { name: string }) => p.name === project).thumbnail;
  };
  const back = () => page.getByRole("button", { name: /Projects|プロジェクト一覧/ }).click();

  await page.goto("/");
  await loginIfNeeded(page);
  await openProject(page, project);
  await expect(page.locator("canvas")).toBeVisible();
  await page.waitForTimeout(1500);

  // No button pressed: going back takes the picture itself.
  await back();
  await expect.poll(async () => (await card())?.current, { timeout: 60_000 }).toBe(true);
  await expect(page.locator(".card", { hasText: project }).first()
    .getByTestId("card-thumbnail")).toBeVisible();

  // Edited, then opened and left again: the outdated picture is retaken.
  const data = await (await page.request.get(`${baseURL}/api/projects/${project}`)).json();
  await page.request.post(`${baseURL}/api/projects/${project}/components/${data.components[0].name}`, {
    data: { x: data.components[0].x + 25 },
  });
  expect((await card()).current).toBe(false);
  await openProject(page, project);
  await expect(page.locator("canvas")).toBeVisible();
  await page.waitForTimeout(1500);
  await back();
  await expect.poll(async () => (await card())?.current, { timeout: 60_000 }).toBe(true);
});
