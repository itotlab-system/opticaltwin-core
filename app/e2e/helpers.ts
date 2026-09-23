import type { Page } from "@playwright/test";

/**
 * AuthGate always shows the login form on a fresh tab, even when the server
 * runs without OT_PASSWORD — in that case /api/auth/login accepts anything.
 * The password field is `required`, so submitting an empty value is blocked by
 * the browser; send a placeholder when no password is configured.
 */
export async function loginIfNeeded(page: Page) {
  // By id, not by label text: the label is translated, and a suite that runs
  // with the UI in Japanese would never find the field.
  const passwordField = page.locator("#login-password");
  // waitFor, not isVisible: isVisible() samples the DOM once and ignores the
  // timeout it is given. It ran before React had painted the gate, so the login
  // was silently skipped and every test then timed out at the gallery instead —
  // which looks like a broken app rather than a test that never logged in.
  const shown = await passwordField
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) return;

  await passwordField.fill(process.env.OT_PASSWORD || "dev");
  // The gate's button is labelled from i18n ("Log in" / "ログイン"), so submit
  // the form from the field instead of matching either wording.
  await passwordField.press("Enter");
}

/**
 * Run one of a card's actions. They live behind the card's "⋯" menu, which is
 * revealed on hover — Playwright's click hovers first, so opening it is enough.
 * `label` is the menu item's visible text ("Rename", "Duplicate", "Delete").
 */
export async function cardAction(page: Page, project: string, label: string) {
  const card = page.locator(".card", { hasText: project }).first();
  await card.locator(".card-menu-btn").click();
  await card.getByRole("menuitem", { name: label, exact: true }).click();
}

/** Project cards in the gallery are divs, not buttons. */
export async function openProject(page: Page, project: string) {
  await page.locator(".card", { hasText: project }).first().click();
}

/** Component rows start collapsed beneath their optical-element type. */
export async function expandAllOutlinerTypes(page: Page) {
  // Every collapsed branch, not just the type headers: the outliner lists the
  // bench in beam order by default, where an optic's mounting hardware folds
  // under the optic itself and only the leftovers sit behind a header. Both
  // views are expanded the same way, so a test that wants every row visible
  // gets it without caring which view is on.
  // Expanded in one in-page pass rather than one round trip per branch: beam
  // order has a branch per optic plus the hardware section, and driving them
  // individually spent most of a 60 s test budget before the test itself began.
  // Clicking in the page also sidesteps actionability waits on headers parked
  // under the outliner's sticky "add a part" bar.
  await page.evaluate(async () => {
    // The arrow, not the row: clicking a component row selects it, which would
    // change the very state the test is about to assert on.
    const collapsed = () => document.querySelectorAll<HTMLElement>(
      ".outliner .type-head[aria-expanded=false],"
      + " .outliner .node[aria-expanded=false] .tree-arrow",
    );
    // Bounded: each pass opens what is currently closed, and opening a branch
    // can reveal another. Ten passes is far more than any bench nests.
    for (let pass = 0; pass < 10; pass++) {
      const closed = collapsed();
      if (closed.length === 0) return;
      closed.forEach((element) => element.click());
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  });
}
