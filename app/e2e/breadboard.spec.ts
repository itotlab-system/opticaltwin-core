import { expect, test } from "@playwright/test";
import { loginIfNeeded } from "./helpers";

test("breadboard X/Y sizes update independently and persist", async ({
  page,
  baseURL,
}) => {
  const projectName = `e2e-board-${Date.now()}`;

  try {
    await page.goto("/");
    await loginIfNeeded(page);
    await page.getByRole("button", { name: "+ New project" }).click();
    await page
      .getByPlaceholder("Project name (e.g. team_a_setup)")
      .fill(projectName);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const extentXNegative = page.getByLabel("X− side (mm)");
    const extentXPositive = page.getByLabel("X＋ side (mm)");
    const extentYNegative = page.getByLabel("Y− side (mm)");
    const extentYPositive = page.getByLabel("Y＋ side (mm)");
    await expect(extentXNegative).toHaveValue("300");
    await expect(extentXPositive).toHaveValue("300");
    await expect(extentYNegative).toHaveValue("175");
    await expect(extentYPositive).toHaveValue("175");

    await extentXPositive.fill("350");
    await extentYNegative.fill("225");
    await page.getByRole("button", { name: "Apply size" }).click();
    await expect(extentXPositive).toHaveValue("350");
    await expect(extentYNegative).toHaveValue("225");

    const payload = await (
      await page.request.get(`${baseURL}/api/projects/${projectName}`)
    ).json();
    expect(payload.board.sizeX).toBe(650);
    expect(payload.board.sizeY).toBe(400);
    expect(payload.board.minSizeX).toBe(600);
    expect(payload.board.minSizeY).toBe(350);
    expect(payload.board.centerX).toBe(25);
    expect(payload.board.centerY).toBe(-25);
    expect(payload.board.extentXNegative).toBe(300);
    expect(payload.board.extentXPositive).toBe(350);
    expect(payload.board.extentYNegative).toBe(225);
    expect(payload.board.extentYPositive).toBe(175);
    expect(payload.board.holes).toHaveLength(26 * 16);

    await extentXNegative.fill("275");
    await expect(
      page.getByRole("button", { name: "Apply size" })
    ).toBeDisabled();
  } finally {
    await page.request
      .post(`${baseURL}/api/projects/${projectName}/remove`)
      .catch(() => undefined);
  }
});
