import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = await realpath(fileURLToPath(new URL("../../../../", import.meta.url)));
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `outside-workspace-${process.pid}-${Date.now()}`);
const statePath = join(userData, "server.json");
async function launch(cwd = repo, profile = userData) {
  await mkdir(profile, { recursive: true });
  const app = await electron.launch({
    executablePath: process.env.THREADPATH_PACKAGED_EXE ?? join(desktop, "node_modules", "electron", "dist", "electron.exe"),
    args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, ...(process.env.THREADPATH_PACKAGED_EXE === undefined ? [join(desktop, "out", "main", "index.js")] : [])],
    env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-new-conversation-app-server.cmd"), CODEX_CWD: cwd, NEW_CONVERSATION_STATE_PATH: join(profile, "server.json"), ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  return { app, page };
}

let { app, page } = await launch();
try {
  await page.locator(".composer-workspace-picker").click();
  await page.getByRole("menuitem", { name: "Work outside a workspace", exact: true }).click();
  await page.getByRole("button", { name: "Work outside a workspace", exact: true }).waitFor();
  await page.locator("#turn-input").fill("General discussion outside a project");
  await page.locator(".composer-send").click();
  await page.locator(".role-user").getByText("General discussion outside a project", { exact: true }).waitFor();
  await page.locator(".role-assistant").getByText("Reply in the newly created conversation.", { exact: true }).waitFor();
  const standalone = await realpath(join(userData, "standalone-runtime"));
  const server: unknown = JSON.parse(await readFile(statePath, "utf8"));
  assert.ok(server !== null && typeof server === "object" && "cwd" in server);
  assert.equal(server.cwd, standalone, "Explicit standalone selection must not normalize into the parent Git project");
  const state = await page.evaluate(() => window.threadPath.getWorkspaceState());
  assert.equal(state.currentPath, standalone);
  assert.equal(state.directories.some((directory) => directory.path === standalone), false);
  assert.equal(state.configuredWorkspaces.some((workspace) => workspace.primaryDirectory === standalone), false);
  assert.equal(state.unclassifiedThreads.some((thread) => thread.id === "created-not-indexed"), true);
  await page.locator(".back-history").click();
  await page.getByRole("button", { name: "Work outside a workspace", exact: true }).waitFor();
  await app.close();
  ({ app, page } = await launch());
  await page.getByRole("button", { name: "Work outside a workspace", exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.threadPath.getWorkspaceState())).currentPath, standalone, "Restart must preserve standalone selection despite CODEX_CWD");
  await page.locator(".language-switch").click();
  await page.getByRole("button", { name: "不在工作区工作", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "outside-workspace-zh.png") });
  await page.locator(".language-switch").click();
  await page.locator(".composer-workspace-picker").click();
  await page.getByRole("menuitem", { name: `📁 ${basename(repo)}`, exact: true }).click();
  assert.equal((await page.evaluate(() => window.threadPath.getWorkspaceState())).currentPath, repo);
  await page.locator(".composer-workspace-name").getByText(basename(repo), { exact: true }).waitFor();
  // A homepage choice must leave the existing standalone conversation unbound to the project.
  const switched = await page.evaluate(() => window.threadPath.getWorkspaceState());
  assert.equal(switched.unclassifiedThreads.find((thread) => thread.id === "created-not-indexed")?.workspacePath, standalone);
  await app.close();
  ({ app, page } = await launch("", `${userData}-fresh`));
  assert.equal((await page.evaluate(() => window.threadPath.getConnectionState())).mode, "history");
  await page.locator(".composer-workspace-picker").click();
  await page.getByRole("menuitem", { name: "Work outside a workspace", exact: true }).click();
  await page.locator("#turn-input").fill("Start without ever selecting a project directory");
  await page.locator(".composer-send").click();
  await page.locator(".role-user").getByText("Start without ever selecting a project directory", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.threadPath.getConnectionState())).mode, "workspace");
  console.log("[e2e] passed standalone selection, private cwd, unclassified history, restart, localization and project switch");
} catch (error: unknown) {
  await page.screenshot({ path: join(artifacts, "outside-workspace-failure.png") }).catch(() => undefined);
  throw error;
} finally { await app.close().catch(() => undefined); }
