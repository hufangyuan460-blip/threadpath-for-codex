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
      ...(executable.includes("missing-fake-app-server") ? { PATH: "", LOCALAPPDATA: join(artifactDirectory, "missing-local-appdata") } : {}),
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

async function assertFixedComposerGeometry(page: Page, expectWelcome: boolean): Promise<number> {
  const geometry = await page.evaluate(() => {
    const rect = (selector: string): { top: number; bottom: number; height: number } | null => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) return null;
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
    };
    return { viewportHeight: window.innerHeight, workspace: rect(".workspace"), details: rect(".details-panel"), composer: rect(".turn-composer"), welcome: rect(".new-conversation-space") };
  });
  assert.ok(geometry.workspace !== null && Math.abs(geometry.workspace.bottom - geometry.viewportHeight) <= 3, `workspace does not reach viewport bottom: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.details !== null && geometry.composer !== null && Math.abs(geometry.composer.bottom - geometry.details.bottom) <= 12, `composer is not anchored to details bottom: ${JSON.stringify(geometry)}`);
  if (expectWelcome) assert.ok(geometry.welcome !== null && geometry.composer !== null && geometry.welcome.bottom <= geometry.composer.top, `welcome overlaps composer: ${JSON.stringify(geometry)}`);
  return geometry.composer?.bottom ?? -1;
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
    await waitForText(page, '[aria-label="Connection status"]', "ready");
    const historyList = page.locator(".thread-list");
    await historyList.waitFor({ state: "visible" });
    const nestedHistoryScrollers = await page.locator(".workspace-history *").evaluateAll((elements) => elements.filter((element) => {
      const style = window.getComputedStyle(element);
      return style.overflowY === "auto" || style.overflowY === "scroll";
    }).length);
    assert.equal(nestedHistoryScrollers, 1, `workspace history must have one global scroller, found ${nestedHistoryScrollers}`);
    await historyList.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const historyScrollTop = await historyList.evaluate((element) => element.scrollTop);
    assert.ok(historyScrollTop > 0, "history list did not scroll independently");
    await openThread(page);
    const composerBottomBeforeScroll = await assertFixedComposerGeometry(page, false);
    await scrollListToBottom(page);
    await page.screenshot({ path: join(artifactDirectory, "selected-long-conversation.png"), fullPage: true });
    const composerBottomAfterScroll = await page.locator(".turn-composer").evaluate((element) => element.getBoundingClientRect().bottom);
    assert.ok(Math.abs(composerBottomAfterScroll - composerBottomBeforeScroll) <= 1, "composer moved after conversation scrolling");
    assert.equal(await page.locator("#composer-model").isDisabled(), true, "model selector must degrade safely without confirmed server support");
    assert.equal(await page.locator("#composer-reasoning").isDisabled(), true, "reasoning selector must degrade safely without confirmed server support");
    await page.locator("[data-turn-id]").first().waitFor({ state: "visible" });
    const renderedCount = await page.locator("[data-turn-id]").count();
    assert.ok(renderedCount > 0 && renderedCount < 24, `expected virtualized DOM, got ${renderedCount} turn nodes`);
    await page.getByRole("button", { name: "Go to turn 1: User turn 1", exact: true }).click();
    await page.locator('[data-turn-id="e2e-turn-1"] .markdown-message h1').waitFor({ state: "visible" });

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

    await page.locator("#turn-input").fill("E2E message");
    await page.locator(".turn-composer button[type=submit]").click();
    const liveTurn = page.locator('[data-turn-id="e2e-live-turn"]');
    await liveTurn.waitFor({ state: "visible" });
    await liveTurn.getByText("streamed fake reply").waitFor({ state: "visible" });
    await liveTurn.locator(".markdown-message strong").getByText("streamed fake reply", { exact: true }).waitFor({ state: "visible" });
    await liveTurn.getByText("completed", { exact: true }).waitFor({ state: "visible" });

    const threadActionsButton = page.getByRole("button", { name: /Thread actions:/ }).first();
    await threadActionsButton.click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const nameInput = page.locator("[role=dialog] input");
    await nameInput.fill("Local E2E name");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".conversation-heading h2").getByText("Local E2E name", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Back to conversation history" }).click();
    await page.getByRole("heading", { name: "Workspace history" }).waitFor({ state: "visible" });
    await page.locator(".thread-row").filter({ hasText: "Local E2E name" }).waitFor({ state: "visible" });
    await page.locator(".thread-row").filter({ hasText: "Local E2E name" }).click();
    await page.locator(".thread-directory").waitFor({ state: "visible" });
    await threadActionsButton.click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.locator("[role=dialog] input").fill("");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".conversation-heading h2").getByText("User turn 1", { exact: true }).waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Back to conversation history" }).click();
    await page.getByRole("heading", { name: "Workspace history" }).waitFor({ state: "visible" });
    await page.waitForFunction((previousScrollTop) => {
      const element = document.querySelector<HTMLElement>(".thread-list");
      if (element === null) return false;
      const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      return element.scrollTop >= Math.min(previousScrollTop, maximumScrollTop) - 1;
    }, historyScrollTop);
    await page.locator(".thread-row").first().click();
    await page.locator(".thread-directory").waitFor({ state: "visible" });
    await page.locator("#turn-input").waitFor({ state: "visible" });

    await page.locator("#turn-input").fill("keep input while switching language");
    await page.getByRole("button", { name: "Switch language" }).click();
    await page.getByRole("button", { name: "返回会话历史" }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#turn-input").inputValue(), "keep input while switching language");
  });
}

async function runNewConversationPath(): Promise<void> {
  await runScenario("new-conversation", "e2e-new", async (page) => {
    await waitForText(page, '[aria-label="Connection status"]', "ready");
    await page.locator("#turn-input").waitFor({ state: "visible" });
    await assertFixedComposerGeometry(page, true);
    await page.screenshot({ path: join(artifactDirectory, "unselected-thread.png"), fullPage: true });
    await page.locator("#turn-input").fill("Start a new workspace conversation");
    await page.locator(".turn-composer button[type=submit]").click();
    await scrollListToBottom(page);
    const liveTurn = page.locator('[data-turn-id="e2e-live-turn"]');
    await liveTurn.waitFor({ state: "visible" });
    await liveTurn.getByText("streamed fake reply").waitFor({ state: "visible" });
    await liveTurn.getByText("completed", { exact: true }).waitFor({ state: "visible" });
  });
}

async function runFirstLaunchDiscoveryPath(): Promise<void> {
  await runScenario("first-launch", "e2e-completed", async (page) => {
    await waitForText(page, '[aria-label="Connection status"]', "ready");
    await page.locator(".onboarding-card").waitFor({ state: "hidden" });
    await page.locator("#turn-input").waitFor({ state: "visible" });
    assert.equal(await page.locator(".composer-send").isDisabled(), true);
    await page.locator(".composer-status").getByText("Confirm a working directory before sending.", { exact: true }).waitFor({ state: "visible" });
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

async function runActiveWriterPath(): Promise<void> {
  await runScenario("existing-thread-active-writer", "e2e-active-writer", async (page) => {
    await openThread(page);
    await page.locator("#turn-input").fill("keep active writer input");
    await page.locator(".turn-composer button[type=submit]").click();
    await page.locator(".composer-status").getByText("This conversation is responding.", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#turn-input").inputValue(), "keep active writer input");
    assert.equal(await page.locator(".composer-send").isDisabled(), true);
    await page.locator(".refresh-status").click();
    await page.locator(".refresh-status").waitFor({ state: "visible" });
    assert.equal(await page.locator("#turn-input").inputValue(), "keep active writer input");
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
  await runNewConversationPath();
  await runCompletedPath();
  await runTerminalPath("e2e-failed", "failed");
  await runTerminalPath("e2e-interrupted", "interrupted");
  await runUnavailableExistingThreadPath();
  await runReadOnlyExistingThreadPath();
  await runActiveWriterPath();
  await runStartupFailurePath();
  console.log("[e2e] desktop critical paths passed");
}

main().catch(async (error: unknown) => {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(artifactDirectory, "failure.log"), error instanceof Error ? error.stack ?? error.message : String(error), "utf8");
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
