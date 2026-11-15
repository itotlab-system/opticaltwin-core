import { expect, test } from "@playwright/test";

// A server started without OT_PASSWORD is open: that is the default, and what
// anyone trying the app for the first time runs. Asking them for a password
// that does not exist stops them at the first screen.
test("an open server shows the app without asking for a password", async ({ page, request }) => {
  const status = await (await request.get("/api/auth/status")).json();
  test.skip(status.required, "this server has a password set");

  await page.goto("/");

  // The first thing a new browser sees is the name prompt, over the gallery.
  await expect(page.locator(".name-pick input")).toBeVisible();
  await expect(page.locator("#login-password")).toHaveCount(0);
});
