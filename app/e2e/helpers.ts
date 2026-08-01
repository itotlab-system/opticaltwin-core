import type { Page } from "@playwright/test";

/**
 * AuthGate always shows the login form on a fresh tab, even when the server
 * runs without OT_PASSWORD — in that case /api/auth/login accepts anything.
 * The password field is `required`, so submitting an empty value is blocked by
 * the browser; send a placeholder when no password is configured.
 */
export async function loginIfNeeded(page: Page) {
  const passwordField = page.getByLabel("Password");
  if (await passwordField.isVisible({ timeout: 5000 }).catch(() => false)) {
    await passwordField.fill(process.env.OT_PASSWORD || "dev");
    await page.getByRole("button", { name: "Login" }).click();
  }
}

/** Project cards in the gallery are divs, not buttons. */
export async function openProject(page: Page, project: string) {
  await page.locator(".card", { hasText: project }).first().click();
}

/** Component rows start collapsed beneath their optical-element type. */
export async function expandAllOutlinerTypes(page: Page) {
  const collapsed = page.locator(".outliner .type-head[aria-expanded=false]");
  while (await collapsed.count()) await collapsed.first().click();
}
