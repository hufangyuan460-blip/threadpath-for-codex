import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `workspace-archive-${process.pid}-${Date.now()}`);
const statePath = join(userData, "synthetic-archive-state.json");
const logPath = join(userData, "archive-requests.jsonl");
const extraWorkspace = join(tmpdir(), `a-long-workspace-directory-to-check-the-composer-layout-${process.pid}-${Date.now()}`);
async function launch(mode = "normal", directory = userData) {
  await mkdir(directory, { recursive: true });
  const app = await electron.launch({ executablePath: process.env.THREADPATH_PACKAGED_EXE ?? join(desktop, "node_modules", "electron", "dist", "electron.exe"), args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${directory}`, ...(process.env.THREADPATH_PACKAGED_EXE === undefined ? [join(desktop, "out", "main", "index.js")] : [])], env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-archive-app-server.cmd"), CODEX_CWD: repo, ARCHIVE_STATE_PATH: statePath, ARCHIVE_REQUEST_LOG: logPath, ARCHIVE_FIXTURE_MODE: mode, ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  await page.locator(".thread-row").first().waitFor();
  return { app, page };
}
function targetRow(page: Page) { return page.locator(".thread-row-wrap").filter({ hasText: "Archive test conversation" }); }
async function openMenu(page: Page) { await targetRow(page).locator(".thread-actions-button").click(); }
async function requests() { return (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; threadId: string | null }); }
async function main(): Promise<void> {
  let { app, page } = await launch();
  try {
    const picker = page.locator(".composer-workspace-picker");
    assert.ok((await picker.textContent())?.includes("threadPath"), "homepage must show current workspace without hovering");
    assert.equal(await picker.getAttribute("title"), repo.replace(/[\\/]+$/, ""));
    assert.ok(!(await picker.textContent())?.includes("＋"), "selected workspace must replace the plus icon");
    await mkdir(extraWorkspace, { recursive: true });
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, extraWorkspace);
    await picker.click();
    await page.locator(".workspace-menu").getByRole("menuitem", { name: "Add workspace" }).click();
    await page.waitForFunction((path) => document.querySelector(".composer-workspace-picker")?.getAttribute("title") === path, extraWorkspace);
    assert.ok((await picker.textContent())?.includes("a-long-workspace-directory"));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 480));
    await page.locator(".theme-switch").selectOption("light");
    await page.getByRole("button", { name: "Switch language" }).click();
    await page.waitForTimeout(100);
    const geometry = await page.evaluate(() => {
      const picker = document.querySelector<HTMLElement>(".composer-workspace-picker")!.getBoundingClientRect();
      const input = document.querySelector<HTMLElement>("#turn-input")!.getBoundingClientRect();
      return { pickerRight: picker.right, inputLeft: input.left, inputWidth: input.width, inputRight: input.right, viewport: innerWidth };
    });
    assert.ok(geometry.pickerRight <= geometry.inputLeft && geometry.inputWidth > 150 && geometry.inputRight <= geometry.viewport, "long workspace name must not overlap the input or overflow at minimum size");
    await page.screenshot({ path: join(artifacts, "homepage-workspace-label.png"), fullPage: true });
    await page.getByRole("button", { name: "切换语言" }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 720));
    await picker.click();
    await page.locator(".workspace-menu").getByRole("menuitem", { name: "📁 threadPath", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".composer-workspace-picker")?.textContent?.includes("threadPath"));

    await openMenu(page);
    await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
    await targetRow(page).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Sync history", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".sync-note")?.textContent?.startsWith("Synced"));
    assert.equal(await targetRow(page).count(), 0, "delayed index cannot bring an archived thread back to regular history");
    await page.locator("#history-filter").selectOption("archived");
    await targetRow(page).waitFor();
    await openMenu(page);
    await page.getByRole("menuitem", { name: "Restore conversation", exact: true }).click();
    await targetRow(page).waitFor({ state: "detached" });
    await page.locator("#history-filter").selectOption("all");
    await targetRow(page).waitFor();

    // Server-side activity must prevent the actual archive RPC, even from stale history rows.
    const active = page.locator(".thread-row-wrap").filter({ hasText: "Externally running conversation" });
    await active.locator(".thread-actions-button").click();
    await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
    await page.locator(".archive-error").waitFor();
    assert.ok(!(await requests()).some((request) => request.method === "thread/archive" && request.threadId === "archive-active"));
    await page.locator(".archive-error button").click();

    await targetRow(page).locator(".thread-row").click();
    await page.locator(".conversation-heading").waitFor();
    await page.locator("#turn-input").fill("Keep this draft across archive and restore");
    await page.locator(".directory-rename").click();
    await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
    await page.locator(".new-conversation-space").waitFor();
    assert.equal(await targetRow(page).count(), 0, "archival from conversation page returns home");
    await app.close();

    ({ app, page } = await launch());
    assert.equal(await targetRow(page).count(), 0, "archived state survives restart");
    await page.locator("#history-filter").selectOption("archived");
    await targetRow(page).locator(".thread-row").click();
    await page.locator(".role-user").getByText("Synthetic archive question", { exact: true }).waitFor();
    assert.equal(await page.locator("#turn-input").isDisabled(), true);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#turn-input")?.value === "Keep this draft across archive and restore");
    const refusal = await page.evaluate(async () => {
      try { await window.threadPath.startTurn("archive-target", "Must restore first"); return "unexpected success"; }
      catch (error: unknown) { return String(error); }
    });
    assert.ok(refusal.includes("Restore the archived conversation"));
    await page.screenshot({ path: join(artifacts, "archived-conversation.png"), fullPage: true });
    await page.locator(".composer-route").getByRole("button", { name: "Restore conversation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#turn-input")?.disabled === false);
    assert.equal(await page.locator("#turn-input").inputValue(), "Keep this draft across archive and restore");
    assert.ok(!(await requests()).some((request) => request.method === "thread/resume" || request.method === "turn/start"), "archive and reads must not resume or invoke the model");
    await app.close();

    ({ app, page } = await launch("failure", `${userData}-failure`));
    await openMenu(page);
    await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
    await page.locator(".archive-error").getByText("Synthetic archive failure", { exact: false }).waitFor();
    assert.equal(await targetRow(page).count(), 1, "failed archival must leave the conversation visible");
    console.log(`[e2e] passed workspace label, archive/restore, stale index, activity guard, failure and restart${process.env.THREADPATH_PACKAGED_EXE === undefined ? "" : " (packaged executable)"}`);
  } catch (error: unknown) {
    await page.screenshot({ path: join(artifacts, "workspace-archive-failure.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally { await app.close().catch(() => undefined); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
