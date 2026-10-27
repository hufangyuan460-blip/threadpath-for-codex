import type { Page } from "playwright-core";

/** Wait for the initial/user sync response to finish rendering before toggling. */
export async function waitForHistorySync(page: Page): Promise<void> {
  await page.locator(".sync-note:not(.sync-syncing):not(.sync-failed)").waitFor();
  await page.locator(".workspace-history > .panel-note").filter({ hasText: /^(Loading…|加载中…)$/ }).waitFor({ state: "hidden" });
}

/** Explicit UI setup only for scenarios that need to interact with history rows. */
export async function expandHistoryWorkspaces(page: Page): Promise<void> {
  await waitForHistorySync(page);
  await page.bringToFront();
  const toggles = page.locator('button.workspace-toggle[aria-expanded]');
  await toggles.first().waitFor();
  const paths = await toggles.locator(".workspace-name").evaluateAll((elements) => elements.map((element) => element.getAttribute("title")!));
  for (const path of paths) {
    const toggle = page.locator('button.workspace-toggle[aria-expanded]').filter({ has: page.getByTitle(path, { exact: true }) });
    if (await toggle.getAttribute("aria-expanded") === "false") {
      await toggle.click();
      // Match the stable workspace path, not a list index that may be reordered.
      await toggle.locator('xpath=self::*[@aria-expanded="true"]').waitFor();
    }
  }
}
