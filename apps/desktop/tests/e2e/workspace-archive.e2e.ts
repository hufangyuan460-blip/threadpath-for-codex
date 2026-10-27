import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright-core";
import { expandHistoryWorkspaces, waitForHistorySync } from "./workspace-history.ts";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const repositoryName = basename(repo);
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `workspace-archive-${process.pid}-${Date.now()}`);
const statePath = join(userData, "synthetic-archive-state.json");
const logPath = join(userData, "archive-requests.jsonl");
const extraWorkspace = join(await realpath(tmpdir()), `a-long-workspace-directory-to-check-the-composer-layout-${process.pid}-${Date.now()}`);
const legacyWorkspace = join(await realpath(tmpdir()), `threadpath-legacy-collapsed-${process.pid}-${Date.now()}`);
const legacyExpanded = { [repo.replace(/[\\/]+$/, "")]: true, [legacyWorkspace]: false };
function workspaceToggle(page: Page, path: string) {
  return page.locator("button.workspace-toggle").filter({ has: page.locator(".workspace-name").and(page.getByTitle(path, { exact: true })) });
}
async function assertAllCollapsed(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll("button.workspace-toggle[aria-expanded]").length >= 2);
  const toggles = page.locator("button.workspace-toggle[aria-expanded]");
  assert.ok(await toggles.count() >= 2, "fixture must exercise multiple real workspaces");
  assert.deepEqual(await toggles.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-expanded"))), Array(await toggles.count()).fill("false"));
  assert.equal(await page.locator(".workspace-thread-list").count(), 0);
}
async function assertLegacyPreferences(): Promise<void> {
  const preferences = JSON.parse(await readFile(join(userData, "threadpath-ui.json"), "utf8")) as { expandedWorkingDirectories?: Record<string, boolean> };
  assert.deepEqual(preferences.expandedWorkingDirectories, legacyExpanded, "legacy true/false entries must remain on disk, not become session state");
}
async function launch(mode = "normal", directory = userData) {
  await mkdir(directory, { recursive: true });
  const app = await electron.launch({ executablePath: process.env.THREADPATH_PACKAGED_EXE ?? join(desktop, "node_modules", "electron", "dist", "electron.exe"), args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${directory}`, ...(process.env.THREADPATH_PACKAGED_EXE === undefined ? [join(desktop, "out", "main", "index.js")] : [])], env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-archive-app-server.cmd"), CODEX_CWD: repo, ARCHIVE_STATE_PATH: statePath, ARCHIVE_REQUEST_LOG: logPath, ARCHIVE_FIXTURE_MODE: mode, ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  await waitForHistorySync(page);
  return { app, page };
}
function targetRow(page: Page) { return page.locator(".thread-row-wrap").filter({ hasText: "Archive test conversation" }); }
async function openMenu(page: Page) { await targetRow(page).locator(".thread-actions-button").click(); }
async function requests() { return (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; threadId: string | null }); }
async function main(): Promise<void> {
  await mkdir(userData, { recursive: true });
  await mkdir(legacyWorkspace, { recursive: true });
  await writeFile(join(userData, "threadpath-ui.json"), JSON.stringify({ workingDirectories: [repo, legacyWorkspace], currentWorkingDirectory: repo, expandedWorkingDirectories: legacyExpanded }));
  let { app, page } = await launch();
  try {
    await assertAllCollapsed(page);
    await assertLegacyPreferences();
    const repositoryPath = repo.replace(/[\\/]+$/, "");
    await workspaceToggle(page, repositoryPath).click();
    await targetRow(page).waitFor();
    assert.equal(await workspaceToggle(page, repositoryPath).getAttribute("aria-expanded"), "true");
    assert.equal(await workspaceToggle(page, legacyWorkspace).getAttribute("aria-expanded"), "false", "expanding one workspace must not expand another");
    await workspaceToggle(page, repositoryPath).click();
    await targetRow(page).waitFor({ state: "detached" });
    await workspaceToggle(page, repositoryPath).click();
    await targetRow(page).waitFor();
    await workspaceToggle(page, legacyWorkspace).click();
    await workspaceToggle(page, legacyWorkspace).locator('xpath=self::*[@aria-expanded="true"]').waitFor();
    const ordinaryState = await page.evaluate(() => window.threadPath.getWorkspaceState());
    assert.ok(ordinaryState.directories.every((directory) => directory.expanded), "ordinary workspace:get-state must preserve manual expansion");
    await targetRow(page).locator(".thread-row").click();
    await page.locator(".conversation-heading").waitFor();
    await page.locator(".refresh-status").click();
    await page.getByRole("button", { name: "Back to conversation history" }).click();
    await targetRow(page).waitFor();
    assert.equal(await workspaceToggle(page, repositoryPath).getAttribute("aria-expanded"), "true", "switching conversations must retain expansion");
    assert.equal(await workspaceToggle(page, legacyWorkspace).getAttribute("aria-expanded"), "true", "route changes and ordinary refresh must retain expansion");
    const beforeFocus = (await page.evaluate(() => window.threadPath.getWorkspaceState())).sync.syncedAt;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    await page.waitForFunction(async (previous) => {
      const state = await window.threadPath.getWorkspaceState();
      return state.sync.state !== "syncing" && state.sync.syncedAt !== previous;
    }, beforeFocus);
    const focusedState = await page.evaluate(() => window.threadPath.getWorkspaceState());
    assert.ok(focusedState.directories.every((directory) => directory.expanded), "completed background focus sync must preserve all manual expansion");
    assert.equal(await workspaceToggle(page, repositoryPath).getAttribute("aria-expanded"), "true");
    const picker = page.locator(".composer-workspace-picker");
    assert.ok((await picker.textContent())?.includes(repositoryName), "homepage must show current workspace without hovering");
    assert.equal(await picker.getAttribute("title"), repo.replace(/[\\/]+$/, ""));
    assert.ok(!(await picker.textContent())?.includes("＋"), "selected workspace must replace the plus icon");
    await mkdir(extraWorkspace, { recursive: true });
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, extraWorkspace);
    await picker.click();
    await page.locator(".workspace-menu").getByRole("menuitem", { name: "Add workspace" }).click();
    await page.waitForFunction((path) => document.querySelector(".composer-workspace-picker")?.getAttribute("title") === path, extraWorkspace);
    await workspaceToggle(page, extraWorkspace).waitFor();
    assert.equal(await workspaceToggle(page, extraWorkspace).getAttribute("aria-expanded"), "false", "new workspace starts collapsed");
    assert.equal(await workspaceToggle(page, repositoryPath).getAttribute("aria-expanded"), "true", "adding a workspace must preserve existing expansion");
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
    await page.locator(".workspace-menu").getByRole("menuitem", { name: `📁 ${repositoryName}`, exact: true }).click();
    await page.waitForFunction((name) => document.querySelector(".composer-workspace-picker")?.textContent?.includes(name), repositoryName);
    await page.getByRole("button", { name: "Sync history", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button.workspace-toggle[aria-expanded="true"]') === null);
    await waitForHistorySync(page);
    await assertAllCollapsed(page);
    await assertLegacyPreferences();
    await expandHistoryWorkspaces(page);

    await openMenu(page);
    await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
    await targetRow(page).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Sync history", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button.workspace-toggle[aria-expanded="true"]') === null);
    await waitForHistorySync(page);
    await assertAllCollapsed(page);
    await expandHistoryWorkspaces(page);
    assert.equal(await targetRow(page).count(), 0, "delayed index cannot bring an archived thread back to regular history");
    await page.locator("#history-filter").selectOption("archived");
    await targetRow(page).waitFor();
    await openMenu(page);
    await page.getByRole("menuitem", { name: "Restore conversation", exact: true }).click();
    await targetRow(page).waitFor({ state: "detached" });
    await page.locator("#history-filter").selectOption("all");
    await targetRow(page).waitFor();

    await targetRow(page).locator(".thread-row").click();
    await page.locator(".conversation-heading").waitFor();
    await page.locator("#turn-input").fill("Keep this draft across archive and restore");
    await page.locator(".directory-rename").click();
    await page.getByRole("menuitem", { name: "Archive conversation", exact: true }).click();
    await page.locator(".new-conversation-space").waitFor();
    assert.equal(await targetRow(page).count(), 0, "archival from conversation page returns home");
    await app.close();

    ({ app, page } = await launch());
    await assertAllCollapsed(page);
    await assertLegacyPreferences();
    await expandHistoryWorkspaces(page);
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

    // B: Before opening the active thread, the renderer has not discovered its activity.
    // The real preload IPC must still reconcile server activity and reject the request.
    await page.getByRole("button", { name: "Back to conversation history" }).click();
    await targetRow(page).waitFor();
    const active = page.locator(".thread-row-wrap").filter({ hasText: "Externally running conversation" });
    await active.locator(".thread-actions-button").click();
    assert.equal(await active.getByRole("menuitem", { name: "Archive conversation", exact: true }).isDisabled(), false, "fixture must exercise undiscovered activity, not an already-disabled UI");
    const beforeRefusal = await requests();
    assert.ok(!beforeRefusal.some((request) => request.method === "thread/read" && request.threadId === "archive-active"), "active thread must not have been opened before the IPC guard check");
    const activeRefusal = await page.evaluate(async () => {
      try { await window.threadPath.setThreadArchived("archive-active", true); return "unexpected success"; }
      catch (error: unknown) { return String(error); }
    });
    assert.match(activeRefusal, /Wait for the running conversation before archiving/);
    const refusalRequests = (await requests()).slice(beforeRefusal.length).filter((request) => request.threadId === "archive-active");
    assert.ok(refusalRequests.some((request) => request.method === "thread/read"), "main process must refresh the active thread before refusing");
    assert.ok(refusalRequests.some((request) => request.method === "thread/turns/list"), "main process must inspect the server turns");
    assert.ok(!refusalRequests.some((request) => request.method === "thread/archive"), "refused IPC must not send an archive RPC");
    await active.locator(".thread-actions-button").click();

    // A: Wait for rendered activity, not merely a possibly stale conversation heading.
    // Run after normal archive/restore checks because confirmed activity holds a workspace lock.
    await active.locator(".thread-row").click();
    await page.locator(".conversation-heading .thread-status").getByText("This conversation is responding.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to conversation history" }).click();
    await active.locator(".thread-actions-button").click();
    assert.equal(await active.getByRole("menuitem", { name: "Archive conversation", exact: true }).isDisabled(), true, "known active thread must disable archival in history");
    assert.ok(!(await requests()).some((request) => request.method === "thread/archive" && request.threadId === "archive-active"), "neither guard may archive an active thread");
    await active.locator(".thread-actions-button").click();
    console.log("[e2e] passed undiscovered-activity IPC reconciliation/refusal and known-activity disabled archive menu");
    await app.close();

    ({ app, page } = await launch("failure", `${userData}-failure`));
    // The persisted fixture moved to this cwd while changing workspaces above.
    // Wait for its asynchronous identity resolution before expanding history.
    await workspaceToggle(page, extraWorkspace).waitFor();
    await expandHistoryWorkspaces(page);
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
