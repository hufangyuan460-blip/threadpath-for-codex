import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

const desktopDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../../../../", import.meta.url));
const fakeExecutable = join(desktopDirectory, "tests", "e2e", "fake-app-server.cmd");
const electronExecutable = join(desktopDirectory, "node_modules", "electron", "dist", "electron.exe");
const artifactDirectory = join(repositoryDirectory, "artifacts", "e2e");

async function launch(mode: string, executable = fakeExecutable, cwd: string | null = repositoryDirectory): Promise<{ application: ElectronApplication; page: Page; output: string[] }> {
  const userDataDirectory = join(artifactDirectory, "user-data", `${mode}-${process.pid}-${Date.now()}`);
  await mkdir(userDataDirectory, { recursive: true });
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userDataDirectory}`, join(desktopDirectory, "out", "main", "index.js")],
    env: {
      ...process.env,
      CODEX_EXECUTABLE: executable,
      ...(cwd === null ? {} : { CODEX_CWD: cwd }),
      FAKE_APP_SERVER_MODE: mode,
      FAKE_APP_SERVER_HAS_THREAD: "true",
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_IS_DEV: "0",
      THREADPATH_E2E: "1",
      THREADPATH_E2E_LANGUAGE: "en-US",
    },
  });
  const output: string[] = [];
  application.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  application.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('[aria-label="Connection status"]').waitFor({ state: "visible" });
  return { application, page, output };
}

async function waitForText(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(({ selector: targetSelector, expected }) => document.querySelector(targetSelector)?.textContent?.includes(expected) === true, { selector, expected: text });
}

async function openThread(page: Page): Promise<void> {
  await waitForText(page, '[aria-label="Connection status"]', "ready");
  const thread = page.locator('.thread-row').first();
  await thread.waitFor({ state: "visible" });
  await thread.click();
  await page.locator('.conversation-heading h2').waitFor({ state: "visible" });
}

async function scrollListToBottom(page: Page): Promise<void> {
  const list = page.locator(".turn-virtual-list");
  await list.hover();
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(200);
}

type ScenarioAction = (page: Page) => Promise<void>;

async function runScenario(name: string, mode: string, action: ScenarioAction, executable = fakeExecutable, cwd: string | null = repositoryDirectory): Promise<void> {
  console.log(`[e2e] starting ${name}`);
  const { application, page, output } = await launch(mode, executable, cwd);
  try {
    await action(page);
    console.log(`[e2e] passed ${name}`);
  } catch (error: unknown) {
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: join(artifactDirectory, `${name}-failure.png`), fullPage: true }).catch(() => undefined);
    await writeFile(join(artifactDirectory, `${name}-failure.log`), `${error instanceof Error ? error.stack ?? error.message : String(error)}\n${output.join("")}`, "utf8");
    throw error;
  } finally {
    await application.close();
    console.log(`[e2e] closed ${name}`);
  }
}

async function runCompletedPath(): Promise<void> {
  await runScenario("completed", "e2e-completed", async (page) => {
    await openThread(page);
    const renderedCount = await page.locator("[data-turn-id]").count();
    assert.ok(renderedCount > 0 && renderedCount < 24, `expected virtualized DOM, got ${renderedCount} turn nodes`);

    await page.locator('.outline-entry').filter({ hasText: "User turn 16" }).click();
    await page.locator('[data-turn-id="e2e-turn-16"]').waitFor({ state: "visible" });

    await scrollListToBottom(page);
    const activeAfterScroll = await page.locator('.outline-entry.active').getAttribute("aria-label");
    assert.ok(activeAfterScroll !== null && !activeAfterScroll.includes("turn 1"), `active outline did not move: ${activeAfterScroll}`);

    const search = page.locator("#turn-search");
    await search.fill("User turn 12");
    await page.locator(".search-result").filter({ hasText: "User turn 12" }).waitFor({ state: "visible" });
    await search.press("Enter");
    await page.locator('[data-turn-id="e2e-turn-12"]').waitFor({ state: "visible" });

    await scrollListToBottom(page);
    await page.locator("#turn-input").fill("E2E message");
    await page.locator(".turn-composer button[type=submit]").click();
    const liveTurn = page.locator('[data-turn-id="e2e-live-turn"]');
    await liveTurn.waitFor({ state: "visible" });
    await liveTurn.getByText("streamed fake reply").waitFor({ state: "visible" });
    await liveTurn.getByText("completed", { exact: true }).waitFor({ state: "visible" });

    const renameButton = page.getByRole("button", { name: /Rename:/ }).first();
    await renameButton.click();
    const nameInput = page.locator(".thread-name-editor input");
    await nameInput.fill("Local E2E name");
    await page.locator(".thread-name-editor button[type=submit]").click();
    await page.locator(".conversation-heading h2").getByText("Local E2E name", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Rename:/ }).first().click();
    await page.getByRole("button", { name: "Restore automatic name" }).click();
    await page.locator(".conversation-heading h2").getByText("User turn 1", { exact: true }).waitFor({ state: "visible" });

    await page.locator("#turn-input").fill("keep input while switching language");
    await page.getByRole("button", { name: "Switch language" }).click();
    await page.getByText("会话", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#turn-input").inputValue(), "keep input while switching language");
  });
}

async function runFirstLaunchDiscoveryPath(): Promise<void> {
  await runScenario("first-launch", "e2e-completed", async (page) => {
    await page.getByRole("heading", { name: "Codex CLI found" }).waitFor({ state: "visible" });
    await page.getByText("Choose a project directory before connecting.").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Choose working directory" }).waitFor({ state: "visible" });
  }, fakeExecutable, null);
}

async function runTerminalPath(mode: "e2e-failed" | "e2e-interrupted", expected: "failed" | "interrupted"): Promise<void> {
  await runScenario(expected, mode, async (page) => {
    await openThread(page);
    await scrollListToBottom(page);
    await page.locator("#turn-input").fill(`E2E ${expected}`);
    await page.locator(".turn-composer button[type=submit]").click();
    const liveTurn = page.locator('[data-turn-id="e2e-live-turn"]');
    await liveTurn.waitFor({ state: "visible" });
    await liveTurn.getByText(expected, { exact: true }).waitFor({ state: "visible" });
  });
}

async function runUnavailableExistingThreadPath(): Promise<void> {
  await runScenario("existing-thread-unavailable", "e2e-deleted", async (page) => {
    await openThread(page);
    await page.locator("#turn-input").fill("keep this text");
    await page.locator(".turn-composer button[type=submit]").click();
    await page.locator(".error-summary").filter({ hasText: "Refresh" }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#turn-input").inputValue(), "keep this text");
  });
}

async function runReadOnlyExistingThreadPath(): Promise<void> {
  await runScenario("existing-thread-read-only", "e2e-readonly", async (page) => {
    await openThread(page);
    await page.locator("#turn-input").fill("keep read-only input");
    await page.locator(".turn-composer button[type=submit]").click();
    await page.locator(".error-summary").filter({ hasText: "cannot accept direct input" }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#turn-input").inputValue(), "keep read-only input");
  });
}

async function runStartupFailurePath(): Promise<void> {
  await runScenario("startup-failure", "e2e-completed", async (page) => {
    await waitForText(page, '[aria-label="Connection status"]', "error");
    await page.getByRole("button", { name: "Reconnect" }).click();
    await waitForText(page, '[aria-label="Connection status"]', "error");
    await page.locator(".footer-error").waitFor({ state: "visible" });
  }, join(desktopDirectory, "tests", "e2e", "missing-fake-app-server.cmd"));
}

async function main(): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  await runFirstLaunchDiscoveryPath();
  await runCompletedPath();
  await runTerminalPath("e2e-failed", "failed");
  await runTerminalPath("e2e-interrupted", "interrupted");
  await runUnavailableExistingThreadPath();
  await runReadOnlyExistingThreadPath();
  await runStartupFailurePath();
  console.log("[e2e] desktop critical paths passed");
}

main().catch(async (error: unknown) => {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(artifactDirectory, "failure.log"), error instanceof Error ? error.stack ?? error.message : String(error), "utf8");
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
