import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `new-unindexed-${process.pid}-${Date.now()}`);
const statePath = join(userData, "synthetic-new-thread.json");
async function launch() {
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({ executablePath: process.env.THREADPATH_PACKAGED_EXE ?? join(desktop, "node_modules", "electron", "dist", "electron.exe"), args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, ...(process.env.THREADPATH_PACKAGED_EXE === undefined ? [join(desktop, "out", "main", "index.js")] : [])], env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-new-conversation-app-server.cmd"), CODEX_CWD: repo, NEW_CONVERSATION_STATE_PATH: statePath, NEW_CONVERSATION_HISTORY_DELAY_MS: "60000", ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  return { app, page };
}
async function main(): Promise<void> {
  let { app, page } = await launch();
  try {
    await page.locator(".new-conversation-space").waitFor();
    await page.locator("#turn-input").fill("Create a conversation while history indexing lags");
    await page.locator(".composer-send").click();
    await page.locator(".conversation-heading h2").filter({ hasText: "Create a conversation while history indexing lags" }).waitFor();
    assert.equal(await page.locator(".new-conversation-space").count(), 0, "accepted creation must leave the homepage");
    const firstUser = page.locator(".role-user").getByText("Create a conversation while history indexing lags", { exact: true });
    await firstUser.waitFor();
    assert.equal(await firstUser.count(), 1, "first accepted message must appear before history hydration without refresh");
    const bounds = await firstUser.boundingBox();
    const listBounds = await page.locator(".turn-virtual-list").boundingBox();
    assert.ok(bounds !== null && listBounds !== null && bounds.y < listBounds.y + listBounds.height && bounds.y + bounds.height > listBounds.y, "the user's first message must be in the visible conversation area");
    await page.screenshot({ path: join(artifacts, "new-conversation-first-message.png"), fullPage: true });
    await page.getByText("Reply in the newly created conversation.", { exact: true }).waitFor();
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".conversation-heading").count(), 1, "the empty history snapshot must not clear selection");
    assert.equal(await firstUser.count(), 1, "model completion must not remove the user's bubble");
    // Keep server turn IDs but omit bodies on every read in this process.
    await page.locator(".refresh-status").click();
    await firstUser.waitFor();
    assert.equal(await firstUser.count(), 1, "a stale manual read must not erase or duplicate accepted input");
    await page.locator("#turn-input").fill("draft on the new conversation");
    await page.getByRole("button", { name: "Back to conversation history" }).click();
    await page.locator(".thread-row").filter({ hasText: "Create a conversation while history indexing lags" }).waitFor();
    await page.screenshot({ path: join(artifacts, "new-conversation-index-lag.png"), fullPage: true });
    await app.close();
    ({ app, page } = await launch());
    await page.locator(".thread-row").filter({ hasText: "Create a conversation while history indexing lags" }).click();
    await page.locator(".conversation-heading").waitFor();
    await page.locator(".role-user").getByText("Create a conversation while history indexing lags", { exact: true }).waitFor();
    assert.equal(await page.locator(".role-user").count(), 1, "persisted server content must replace the local placeholder once");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#turn-input")?.value === "draft on the new conversation");
    const metadata: unknown = JSON.parse(await readFile(join(userData, "threadpath-ui.json"), "utf8"));
    assert.ok(metadata !== null && typeof metadata === "object" && "historyMirror" in metadata);
    console.log(`[e2e] passed new conversation navigation, unindexed history retention and restart${process.env.THREADPATH_PACKAGED_EXE === undefined ? "" : " (packaged executable)"}`);
  } catch (error: unknown) {
    await page.screenshot({ path: join(artifacts, "new-conversation-index-lag-failure.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally { await app.close().catch(() => undefined); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
