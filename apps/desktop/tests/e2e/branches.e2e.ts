import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `branches-${process.pid}-${Date.now()}`);
const statePath = join(userData, "synthetic-server.json");
async function launch(mode = "normal"): Promise<{ app: ElectronApplication; page: Page }> {
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: join(desktop, "node_modules", "electron", "dist", "electron.exe"),
    args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, join(desktop, "out", "main", "index.js")],
    env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-fork-app-server.cmd"), CODEX_CWD: repo, FAKE_FORK_STATE_PATH: statePath, FAKE_FORK_E2E: "1", FAKE_FORK_MODE: mode, ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  return { app, page };
}
async function selected(page: Page, title: string): Promise<void> {
  await page.waitForFunction((expected) => document.querySelector(".conversation-heading h2")?.textContent === expected && document.querySelector<HTMLTextAreaElement>(".turn-composer textarea")?.disabled === false, title);
}
async function route(page: Page, id: string, title: string): Promise<void> {
  await page.locator(`[data-branch-thread-id="${id}"]`).click();
  await selected(page, title);
}
async function main(): Promise<void> {
  let { app, page } = await launch();
  try {
    await page.locator(".thread-row").filter({ hasText: "Choose a project architecture" }).click();
    const sourceTitle = "Compare two ways to organize conversation history.";
    await selected(page, sourceTitle);
    const composer = page.locator(".turn-composer textarea");
    await composer.fill("source draft survives branching");
    await page.getByRole("button", { name: "Branch from turn 1", exact: true }).click();
    await selected(page, "Branch 1");
    await page.locator(".branch-node").first().waitFor();
    await page.getByText("Inherited history ends here", { exact: true }).waitFor();
    await page.getByText("Your next message starts an independent discussion on this branch.", { exact: true }).waitFor();
    assert.equal(await page.locator(".branch-node").count(), 2);
    assert.equal(await page.locator('[data-turn-id="source-later"]').count(), 0, "cutoff must exclude later source history");
    await page.locator(".composer-route").filter({ hasText: "Read-only discussion" }).waitFor();
    await composer.fill("branch-only alternative");
    await page.locator(".composer-send").click();
    await page.waitForFunction(() => document.querySelector(".conversation")?.textContent?.includes("Independent reply: branch-only alternative"));
    assert.equal(await composer.inputValue(), "", "accepted send clears only its draft");
    await page.getByText("New discussion on this branch", { exact: true }).waitFor();
    await composer.fill("branch draft survives restart");
    await route(page, "fixture-source", sourceTitle);
    assert.equal(await composer.inputValue(), "source draft survives branching");
    assert.equal(await page.locator(".conversation").filter({ hasText: "branch-only alternative" }).count(), 0, "source history must not acquire branch input");
    await route(page, "fixture-thread-1", "Branch 1");
    assert.equal(await composer.inputValue(), "branch draft survives restart");
    await page.getByRole("button", { name: "Branch from turn 1", exact: true }).click();
    await selected(page, "Branch 2");
    assert.equal(await page.locator(".branch-node").count(), 3);
    assert.equal(await composer.inputValue(), "");
    await route(page, "fixture-source", sourceTitle);
    await page.getByRole("button", { name: "Branch from turn 1", exact: true }).click();
    await selected(page, "Branch 3");
    assert.equal(await page.locator(".branch-node").count(), 4);
    await page.getByRole("button", { name: "Collapse", exact: true }).click();
    assert.equal(await page.locator(".branch-node").count(), 0);
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    await route(page, "fixture-thread-1", "Branch 1");
    // Capture the full family and current send target without changing layout through test-only CSS.
    await page.locator(".branch-map-scroll").evaluate((element) => { element.scrollTop = 0; element.scrollLeft = 0; });
    await page.screenshot({ path: join(artifacts, "branch-routes.png"), fullPage: true });
    const geometry = await page.evaluate(() => {
      const composer = document.querySelector(".turn-composer")!.getBoundingClientRect();
      const details = document.querySelector(".details-panel")!.getBoundingClientRect();
      const map = document.querySelector(".branch-map")!.getBoundingClientRect();
      return { composerBottom: composer.bottom, detailsBottom: details.bottom, mapBottom: map.bottom, composerTop: composer.top };
    });
    assert.ok(Math.abs(geometry.composerBottom - geometry.detailsBottom) < 12);
    assert.ok(geometry.mapBottom < geometry.composerTop);
    await page.locator(".language-switch").click();
    await page.locator(".branch-map-heading h3").filter({ hasText: "讨论路线" }).waitFor();
    await page.locator(".theme-switch").selectOption("light");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.screenshot({ path: join(artifacts, "branch-routes-zh-light.png"), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(760, 480));
    const compact = await page.locator(".turn-composer textarea").boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    assert.ok(compact !== null && compact.x + compact.width <= viewport.width + 1 && compact.y + compact.height <= viewport.height + 1, "composer must remain visible at minimum window size");
    await page.screenshot({ path: join(artifacts, "branch-routes-compact.png"), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1120, 760));
    await page.locator(".language-switch").click();
    await page.locator(".branch-map-heading h3").filter({ hasText: "Discussion routes" }).waitFor();
    await app.close();
    ({ app, page } = await launch());
    await page.locator(".thread-row").filter({ hasText: "Branch 1" }).first().click();
    await selected(page, "Branch 1");
    assert.equal(await page.locator(".branch-node").count(), 4, "restart restores the saved branch family");
    assert.equal(await page.locator(".turn-composer textarea").inputValue(), "branch draft survives restart");
    await page.locator('[data-branch-source-id="fixture-thread-1"]').click();
    await selected(page, sourceTitle);
    await page.locator(".outline-entry.active").filter({ hasText: sourceTitle }).waitFor();
    assert.equal(await page.locator(".turn-composer textarea").inputValue(), "source draft survives branching");
    await route(page, "fixture-thread-1", "Branch 1");
    await page.locator(".composer-send").click();
    await page.waitForFunction(() => document.querySelector(".conversation")?.textContent?.includes("Independent reply: branch draft survives restart"));
    const raw: unknown = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(raw !== null && typeof raw === "object" && "threads" in raw);
    const threads = (raw as { threads: Record<string, { lastResumeSandbox?: string; turns: unknown[] }> }).threads;
    assert.equal(threads["fixture-thread-1"]?.lastResumeSandbox, "read-only", "restart send must enforce the sandbox again");
    assert.equal(threads["fixture-source"]?.turns.length, 2);
    await app.close();
    ({ app, page } = await launch("unsupported"));
    await page.locator(".thread-row").filter({ hasText: "Branch 1" }).first().click();
    await selected(page, "Branch 1");
    await page.locator(".turn-composer textarea").fill("draft preserved after unsupported fork");
    await page.getByRole("button", { name: "Branch from turn 1", exact: true }).click();
    await page.locator(".branch-error").filter({ hasText: "Method not found" }).waitFor();
    await selected(page, "Branch 1");
    assert.equal(await page.locator(".branch-node").count(), 4);
    assert.equal(await page.locator(".turn-composer textarea").inputValue(), "draft preserved after unsupported fork");
    await app.close();
    ({ app, page } = await launch("unsafe-sandbox"));
    await page.locator(".thread-row").filter({ hasText: "Branch 1" }).first().click();
    await selected(page, "Branch 1");
    await page.locator(".composer-send").click();
    await page.waitForFunction(() => document.querySelector(".turn-composer")?.textContent?.includes("read-only"));
    await page.locator(".turn-composer .error-summary").waitFor();
    assert.equal(await page.locator(".turn-composer textarea").inputValue(), "draft preserved after unsupported fork");
    const unsafeState: unknown = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal((unsafeState as { threads: Record<string, { turns: unknown[] }> }).threads["fixture-thread-1"]?.turns.length, 3, "unconfirmed sandbox must prevent turn/start");
    console.log("[e2e] passed branch cutoff, independent send, nested/sibling routes, draft switching, restart, unsupported fork and unsafe sandbox");
  } catch (error: unknown) {
    await page.screenshot({ path: join(artifacts, "branches-failure.png"), fullPage: true }).catch(() => undefined);
    await writeFile(join(artifacts, "branches-failure.log"), error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally { await app.close().catch(() => undefined); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
