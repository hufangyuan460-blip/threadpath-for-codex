import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "playwright-core";

const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const artifacts = join(repo, "artifacts", "e2e");
async function waitSelected(page: Page, title: string): Promise<void> {
  await page.waitForFunction((expected) => document.querySelector(".conversation-heading h2")?.textContent === expected && document.querySelector<HTMLTextAreaElement>(".turn-composer textarea")?.disabled === false && document.querySelector(".branch-point-loading") === null, title);
}
async function assertJump(page: Page): Promise<void> {
  await waitSelected(page, "Source conversation");
  await page.locator(".outline-entry.active").filter({ hasText: "Source question 12" }).waitFor();
  const geometry = await page.locator('[data-turn-id="source-12"]').evaluate((element) => {
    const card = element.getBoundingClientRect();
    const list = document.querySelector(".turn-virtual-list")!.getBoundingClientRect();
    return { top: card.top, listTop: list.top, listBottom: list.bottom };
  });
  assert.ok(geometry.top >= geometry.listTop - 3 && geometry.top < geometry.listBottom, "source jump must land on the cutoff, not just load it somewhere in the DOM");
}
async function scenario(mode: string): Promise<void> {
  const userData = join(artifacts, "user-data", `branch-point-${mode}-${process.pid}-${Date.now()}`);
  await mkdir(userData, { recursive: true });
  const requestLog = join(userData, "requests.jsonl");
  const branch = { threadId: "branch-child", sourceThreadId: "branch-source", forkTurnId: "source-12", forkLabel: "Source question 12", readOnly: true, createdAt: "2026-10-12T00:00:00Z" };
  const other = { ...branch, threadId: "branch-other" };
  await writeFile(join(userData, "threadpath-ui.json"), JSON.stringify({ language: "en-US", threadNames: { "branch-source": "Source conversation", "branch-child": "Alternative plan", "branch-other": "Other route" }, threadBranches: { "branch-child": branch, "branch-other": other }, threadDrafts: { "branch-source": "source draft", "branch-child": "branch draft" } }));
  const app = await electron.launch({ executablePath: process.env.THREADPATH_PACKAGED_EXE ?? join(desktop, "node_modules", "electron", "dist", "electron.exe"), args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, ...(process.env.THREADPATH_PACKAGED_EXE === undefined ? [join(desktop, "out", "main", "index.js")] : [])], env: { ...process.env, CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-branch-point-app-server.cmd"), CODEX_CWD: repo, BRANCH_POINT_MODE: mode, BRANCH_POINT_REQUEST_LOG: requestLog, ELECTRON_IS_DEV: "0", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US" } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  try {
    await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
    await page.locator(".thread-row").filter({ hasText: "Alternative plan" }).click();
    await waitSelected(page, "Alternative plan");
    const origin = page.locator('[data-branch-source-id="branch-child"]');
    assert.match(await origin.innerText(), /From: Source conversation/);
    assert.match(await origin.innerText(), /Source turn: Source question 12/);
    assert.equal(await page.locator(".turn-composer textarea").inputValue(), "branch draft");
    await page.locator(".branch-boundary-notice").waitFor();
    assert.equal(await page.locator('[data-history-kind="inherited"]').count(), 0, "unloaded cutoff must not invent inherited history");
    await origin.focus();
    await origin.press("Enter");
    if (mode === "delayed") {
      await page.locator(".branch-point-loading").waitFor();
      await page.locator('[data-branch-thread-id="branch-other"]').click();
      await waitSelected(page, "Other route");
      await page.waitForTimeout(400);
      assert.equal(await page.locator(".conversation-heading h2").innerText(), "Other route", "late source read must not switch the route back");
      assert.equal(await page.locator(".branch-point-error").count(), 0);
    } else if (mode === "wrong-source") {
      await page.locator(".branch-point-error").filter({ hasText: "Could not load" }).waitFor();
      assert.equal(await page.locator(".turn-composer textarea").isDisabled(), true);
      assert.equal(await page.locator(".conversation-heading").count(), 0, "a wrong thread response must not be displayed as the source");
    } else if (mode === "missing") {
      await page.locator(".branch-point-error").filter({ hasText: "no longer available" }).waitFor();
      await waitSelected(page, "Source conversation");
      assert.equal(await page.locator('[data-turn-id="source-12"]').count(), 0);
      assert.equal(await page.locator(".turn-composer textarea").inputValue(), "source draft");
    } else {
      if (mode === "fail-once") {
        await page.locator(".branch-point-error").filter({ hasText: "Could not load" }).waitFor();
        await page.getByRole("button", { name: "Retry branch-point navigation" }).click();
      }
      await assertJump(page);
      assert.equal(await page.locator(".turn-composer textarea").inputValue(), "source draft");
      await page.locator('[data-branch-thread-id="branch-child"]').click();
      await waitSelected(page, "Alternative plan");
      assert.equal(await page.locator(".turn-composer textarea").inputValue(), "branch draft");
      await page.getByRole("button", { name: "Show inherited-history boundary" }).click();
      await waitSelected(page, "Alternative plan");
      await page.locator('[data-cutoff-turn-id="source-12"]').waitFor();
      assert.equal(await page.locator('[data-turn-id="source-12"]').getAttribute("data-history-kind"), "inherited");
      assert.equal(await page.locator('[data-turn-id="branch-new-1"]').getAttribute("data-history-kind"), "branch");
      await page.getByText("New discussion on this branch", { exact: true }).waitFor();
      if (mode === "normal") {
        await page.locator(".language-switch").click();
        await page.getByText("继承历史到此结束", { exact: true }).waitFor();
        await page.locator('[data-cutoff-turn-id="source-12"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, "branch-point-boundary.png"), fullPage: true });
      }
    }
    const requests = (await readFile(requestLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { method: string; threadId: string; cursor: string | null });
    assert.ok(requests.every((request) => request.method !== "thread/resume" && request.method !== "turn/start"), "navigation must only read history");
    const olderSourcePages = requests.filter((request) => request.method === "thread/turns/list" && request.threadId === "branch-source" && request.cursor !== null);
    assert.equal(olderSourcePages.length === 0, mode === "delayed" || mode === "wrong-source", "older-page loading must stop after switching away or rejecting a wrong thread");
    console.log(`[e2e] passed branch-point ${mode}`);
  } catch (error: unknown) {
    await page.screenshot({ path: join(artifacts, `branch-point-${mode}-failure.png`), fullPage: true }).catch(() => undefined);
    throw error;
  } finally { await app.close(); }
}
async function main(): Promise<void> { for (const mode of ["normal", "fail-once", "missing", "delayed", "wrong-source"]) await scenario(mode); }
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
