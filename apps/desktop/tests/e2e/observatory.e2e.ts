import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page, type ElectronApplication } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const artifacts = join(repo, "artifacts", "e2e");
const userData = join(artifacts, "user-data", `observatory-${process.pid}-${Date.now()}`);
const statePath = join(userData, "synthetic-server.json");

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: join(desktop, "node_modules", "electron", "dist", "electron.exe"),
    args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, join(desktop, "out", "main", "index.js")],
    env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-fork-app-server.cmd"), CODEX_CWD: repo, FAKE_FORK_STATE_PATH: statePath, FAKE_FORK_E2E: "1", FAKE_OBSERVATORY: "1", ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
  return { app, page };
}

async function openThread(page: Page, label: string, id: string): Promise<void> {
  if (await page.locator(".thread-directory").count()) await page.locator(".back-history").click();
  await page.locator(".thread-row").filter({ hasText: label }).first().click();
  await page.locator(`[data-usage-thread-id="${id}"]`).waitFor();
  await page.locator(".conversation-heading h2").waitFor();
}

async function main(): Promise<void> {
  let { app, page } = await launch();
  try {
    await openThread(page, "Choose a project architecture", "fixture-source");
    await page.locator(".usage-observatory summary").click();
    await page.locator(".usage-empty").filter({ hasText: "No server usage data yet" }).waitFor();
    await page.locator(".usage-observatory summary").click();
    await page.locator(".turn-composer textarea").fill("Observe the synthetic usage");
    await page.locator(".composer-send").click();
    await page.locator(".usage-observatory summary").filter({ hasText: "60.3K" }).waitFor();
    await page.locator(".usage-observatory summary").click();
    await page.locator(".usage-details dd").filter({ hasText: /^resumed$/ }).waitFor();
    await page.locator('[data-compaction-id="fixture-turn-1-compaction"]').filter({ hasText: "started" }).waitFor();
    await page.locator(".usage-details dd").filter({ hasText: /^live$/ }).waitFor();
    await page.getByRole("heading", { name: "Latest server snapshot", exact: true }).waitFor();
    await page.locator(".usage-details dd").filter({ hasText: /^70,000$/ }).waitFor();
    assert.equal(await page.locator('[data-compaction-id="fixture-turn-1-compaction"]').count(), 1);
    await page.locator('[data-compaction-id="fixture-turn-1-compaction"]').filter({ hasText: "completed" }).waitFor();
    assert.ok((await page.locator(".usage-observatory summary").innerText()).includes("Model-reported window Unknown"));
    await page.locator(".usage-observatory summary").click();
    await page.locator('.compaction-marker[data-compaction-status="completed"]').waitFor();

    await openThread(page, "Unknown usage conversation", "fixture-unknown");
    await page.locator(".usage-observatory summary").click();
    await page.locator(".usage-empty").waitFor();
    await page.locator('[data-compaction-id="history-compaction"]').filter({ hasText: "unknown" }).waitFor();
    assert.equal(await page.locator(".usage-details").filter({ hasText: "70,000" }).count(), 0, "thread switch cannot leak counters");
    await page.locator(".usage-observatory summary").click();

    await openThread(page, "Choose a project architecture", "fixture-source");
    assert.ok((await page.locator(".usage-observatory summary").innerText()).includes("70K"));
    await page.locator('.compaction-marker[data-compaction-status="completed"]').waitFor();
    const observedAfterReread = await page.evaluate(() => window.threadPath.getThreadObservatory("fixture-source"));
    assert.equal(observedAfterReread.compactions.find((item) => item.itemId === "fixture-turn-1-compaction")?.status, "completed");
    await page.getByRole("button", { name: "Branch from turn 1", exact: true }).click();
    await page.locator('[data-usage-thread-id="fixture-thread-1"] summary').click();
    await page.locator(".usage-fork-warning").filter({ hasText: "inherited" }).waitFor();
    await page.locator(".usage-details dd").filter({ hasText: /^60,321$/ }).waitFor();
    assert.equal(await page.locator(".usage-details").filter({ hasText: "9,679" }).count(), 0, "no branch subtraction");
    await page.locator(".language-switch").click();
    await page.locator(".usage-fork-warning").filter({ hasText: "累计用量可能包含从源会话继承的历史。" }).waitFor();
    await page.locator(".usage-details h3").filter({ hasText: "最近服务器快照" }).waitFor();
    await page.locator(".language-switch").click();

    // Connection lifecycle through real preload IPC, with no resume just to fetch usage.
    await page.evaluate(() => window.threadPath.disconnect());
    const stale = await page.evaluate(() => window.threadPath.getThreadObservatory("fixture-thread-1"));
    assert.equal(stale.usage?.stale, true);
    await page.evaluate(() => window.threadPath.connect());
    await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
    const reconnected = await page.evaluate(() => window.threadPath.getThreadObservatory("fixture-thread-1"));
    assert.equal(reconnected.usage?.stale, true);
    // The selected route may be cleared by the existing disconnect UI; reselect via home.
    if (await page.locator(".thread-directory").count()) await page.locator(".back-history").click();
    await page.locator(".thread-row").filter({ hasText: "Branch 1" }).first().click();
    await page.locator(".usage-observatory summary").filter({ hasText: "stale" }).waitFor();
    await page.locator(".usage-observatory summary").click();
    await page.locator(".usage-details dd").filter({ hasText: /^60,321$/ }).waitFor();
    await page.setViewportSize({ width: 960, height: 640 });
    for (const theme of ["graphite", "black", "light"]) {
      await page.locator(".theme-switch").selectOption(theme);
      const bounds = await page.locator(".usage-details").boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 960 && bounds.y + bounds.height <= 640, "details fit the minimum viewport");
      await page.screenshot({ path: join(artifacts, `observatory-${theme}.png`) });
    }
    const prefs = await readFile(join(userData, "threadpath-ui.json"), "utf8");
    assert.ok(!prefs.includes("totalTokens") && !prefs.includes("receivedAt"), "usage must not persist in preferences");
    await app.close();
    ({ app, page } = await launch());
    await page.locator(".thread-row").filter({ hasText: "Branch 1" }).first().click();
    await page.locator(".usage-observatory summary").click();
    await page.locator(".usage-empty").waitFor();
    await page.locator(".usage-fork-warning").waitFor();
    console.log("[e2e] passed observatory unknown/live/resumed/stale, details, null window, compaction, fork, thread isolation, themes and restart");
  } catch (error: unknown) {
    await page.screenshot({ path: join(artifacts, "observatory-failure.png"), fullPage: true }).catch(() => undefined);
    await writeFile(join(artifacts, "observatory-failure.log"), error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally { await app.close().catch(() => undefined); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
