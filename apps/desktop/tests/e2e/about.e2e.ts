import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `about-${process.pid}-${Date.now()}`);
const expected: unknown = JSON.parse(await readFile(join(desktop, "out", "main", "build-info.json"), "utf8"));
const manifest: unknown = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
assert.ok(manifest !== null && typeof manifest === "object" && "version" in manifest);
assert.ok(expected !== null && typeof expected === "object" && "version" in expected && "commit" in expected && "dirty" in expected && "tag" in expected);
assert.equal(expected.version, manifest.version);
await mkdir(userData, { recursive: true });
const packaged = process.env.THREADPATH_PACKAGED_EXE;
const app = await electron.launch({
  executablePath: packaged ?? join(desktop, "node_modules", "electron", "dist", "electron.exe"),
  args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, ...(packaged === undefined ? [join(desktop, "out", "main", "index.js")] : [])],
  env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-new-conversation-app-server.cmd"), CODEX_CWD: repo, NEW_CONVERSATION_STATE_PATH: join(userData, "server.json"), ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
try {
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  if (packaged !== undefined) assert.equal(await app.evaluate(({ app }) => app.getVersion()), expected.version, "Native packaged app version must match the About version");
  const trigger = page.getByRole("button", { name: "About ThreadPath", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "ThreadPath for Codex", exact: true });
  await dialog.waitFor();
  const info = await page.evaluate(() => window.threadPath.getAppInfo());
  assert.deepEqual({ version: info.version, commit: info.commit, dirty: info.dirty, tag: info.tag }, expected);
  assert.equal(await dialog.locator("[data-build-version]").innerText(), expected.version);
  assert.equal(await dialog.locator("[data-build-commit]").innerText(), expected.commit ?? "Source unavailable");
  assert.equal(await dialog.locator("[data-build-status]").innerText(), expected.commit === null ? "Source unavailable" : expected.dirty ? "Development build · uncommitted changes" : expected.tag ?? "Development build");
  // Native modal focus stays inside the dialog, including keyboard traversal.
  await page.keyboard.press("Tab");
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  await page.locator(".language-switch").click();
  await page.locator(".theme-switch").selectOption("light");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 480));
  await page.getByRole("button", { name: "关于 ThreadPath", exact: true }).click();
  await dialog.getByText("应用版本", { exact: true }).waitFor();
  await dialog.getByText("源码提交", { exact: true }).waitFor();
  const bounds = await dialog.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds !== null && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
  await page.screenshot({ path: join(artifacts, packaged === undefined ? "about-zh-light.png" : "about-packaged-zh-light.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  console.log(`[e2e] passed version/source provenance, About focus, language and compact layout${packaged === undefined ? "" : " (packaged executable)"}`);
} catch (error: unknown) {
  await page.screenshot({ path: join(artifacts, "about-failure.png") }).catch(() => undefined);
  throw error;
} finally { await app.close().catch(() => undefined); }
