import { test, expect } from "@playwright/test";
import fs from "node:fs";

// Issue #92: a "Snapshot" button in the toolbar downloads the current
// viewport as a PNG named "<project>-<timestamp>.png".

function readPngSize(path: string): { width: number; height: number } {
  const buf = fs.readFileSync(path);
  // IHDR chunk: width/height are big-endian uint32 at byte offsets 16/20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// server.py gates the app behind a shared password when OT_PASSWORD is set
// (via AuthGate.tsx). Unset, no login is shown and this is a no-op; set it in
// the environment to run these tests against a password-protected server.
async function loginIfNeeded(page: import("@playwright/test").Page) {
  const passwordField = page.getByLabel("Password");
  if (await passwordField.isVisible({ timeout: 5000 }).catch(() => false)) {
    await passwordField.fill(process.env.OT_PASSWORD ?? "");
    await page.getByRole("button", { name: "Login" }).click();
  }
}

test("snapshot button downloads a non-blank PNG named after the project", async ({ page, baseURL }) => {
  const projectName = `e2e-snapshot-${Date.now()}`;

  try {
    await page.goto("/");
    await loginIfNeeded(page);
    await page.getByRole("button", { name: "+ New project" }).click();
    await page.getByPlaceholder("Project name (e.g. team_a_setup)").fill(projectName);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.locator("canvas")).toBeVisible();

    // The button stays disabled until the WebGL renderer's first frame
    // completes; Playwright's click() auto-waits for it to become enabled.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Snapshot" }).click(),
    ]);

    const filenamePattern = new RegExp(
      `^${projectName}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.png$`
    );
    expect(download.suggestedFilename()).toMatch(filenamePattern);

    const path = await download.path();
    expect(path).not.toBeNull();
    const stats = fs.statSync(path!);
    expect(stats.size).toBeGreaterThan(5000);

    const { width, height } = readPngSize(path!);
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(100);
  } finally {
    // The backend persists projects as real files under projects/<name>/ —
    // clean up the one this test created so repeated runs don't litter it.
    await page.request.post(`${baseURL}/api/projects/${projectName}/remove`).catch(() => undefined);
  }
});
