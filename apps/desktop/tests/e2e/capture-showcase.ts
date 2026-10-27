import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { waitForHistorySync } from "./workspace-history.ts";

// Run after pnpm build: pnpm --filter @threadpath/desktop exec node --experimental-strip-types tests/e2e/capture-showcase.ts
// Fixed local fixture only: no configurable executable, real history, authentication, or model calls.
const desktop = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const output = join(repo, "docs", "screenshots");
const scratchParent = join(repo, "artifacts", "showcase");
const topics = [
  "Design a searchable conversation archive",
  "Group history by workspace",
  "Keep long conversations readable",
  "Navigate between user inputs and model replies",
  "Find a decision without rereading everything",
  "Compare linear history with discussion branches",
  "Keep each branch focused on one alternative",
  "Return to the original question",
  "Preserve drafts when switching routes",
  "Archive completed explorations",
  "Observe server-reported token usage",
  "Review the implementation checklist",
];
const responses = [
  "## A calm place for conversation history\n\nOrganize the archive around **workspaces**, then make each conversation easy to revisit. Keep coding and approvals in the official Codex client.\n\n- Group related conversations by project.\n- Search for a question or a past decision.\n- Branch from a completed turn to explore an alternative.",
  "## Workspaces first\n\nShow a compact project list. Expand only the workspace you need, keep useful discussions starred, and archive finished conversations. Local names help make the history recognizable.",
  "## Read without losing your place\n\nUse a virtualized message list and load earlier turns in pages. Keep the composer anchored while the conversation scrolls.\n\nThe message directory should distinguish **user inputs** from **model replies**.",
  "## Jump to the message that matters\n\nSelect an entry in the message directory to move directly to its body. A user question and its answer have separate destinations, even inside the same turn.\n\n| Task | Navigation |\n| --- | --- |\n| Revisit a request | User input entry |\n| Read the recommendation | Model reply entry |\n| Find a phrase | Conversation search |",
  "## Search the discussion\n\nSearch the loaded conversation, inspect the matching messages, and jump back to the surrounding context. Load earlier history when the decision lives beyond the current page.",
  "## Explore another route\n\nA **linear history** is simple to scan. A **discussion branch** preserves the context up to a chosen turn and gives an alternative its own continuation.\n\nChoose the branch when you want to compare approaches without mixing the follow-up questions.",
  "## One alternative per route\n\nKeep the original discussion intact. Branch discussions share the source working directory and require a confirmed read-only policy; they do not isolate project files.",
  "## Keep the source close\n\nThe route map records the source conversation and the question where the route split. Follow the source link to revisit that exact turn.",
  "## Continue with the right draft\n\nEach conversation has its own saved draft. Switching routes should restore the corresponding text so an unfinished thought stays with its discussion.",
  "## Close the loop\n\nArchive a completed conversation through Codex, keep its history readable, and restore it when the exploration becomes relevant again. Hiding a row locally is a separate action.",
  "## Read the counters honestly\n\nUse only the usage snapshots returned by the server. Cumulative tokens and the latest snapshot are useful observations, but neither is exact context occupancy or a price estimate.",
  "## Ready to revisit\n\n- [x] Workspaces organize the archive.\n- [x] Message entries lead to readable content.\n- [x] Branch routes retain their source question.\n- [x] Usage remains explicitly server-reported.\n\nThis is a synthetic demonstration conversation, created locally for product screenshots.",
];

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
  await page.mouse.move(1590, 990);
}

async function main(): Promise<void> {
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(join(scratchParent, "capture-"));
  const userData = join(scratch, "profile");
  const projects = ["Atlas-Desktop", "Orion-API", "Field-Notes"].map((name) => join(scratch, name));
  let app: ElectronApplication | undefined;
  try {
    for (const path of [userData, join(userData, "codex"), ...projects]) await mkdir(path, { recursive: true });
    const turns = topics.map((text, index) => ({ id: `demo-turn-${index + 1}`, status: "completed", items: [
      { id: `demo-user-${index + 1}`, type: "userMessage", text },
      { id: `demo-answer-${index + 1}`, type: "agentMessage", text: responses[index] },
    ] }));
    const thread = (id: string, title: string, cwd: string, history = turns.slice(0, 2)) => ({ id, sessionId: id, forkedFromId: null, title, cwd, status: "idle", canAcceptDirectInput: true, turns: history });
    const statePath = join(scratch, "synthetic-server.json");
    const threads = [
      thread("fixture-source", topics[0]!, projects[0]!, turns),
      thread("demo-navigation", "Review message navigation and search", projects[0]!),
      thread("demo-reliability", "Plan a reliable desktop release", projects[0]!),
      thread("demo-api", "Compare API pagination approaches", projects[1]!),
      thread("demo-cache", "Discuss cache invalidation boundaries", projects[1]!),
      thread("demo-notes", "Collect product research notes", projects[2]!),
    ];
    await writeFile(statePath, JSON.stringify({ nextThread: 1, nextTurn: 1, threads: Object.fromEntries(threads.map((item) => [item.id, item])) }));
    await writeFile(join(userData, "threadpath-ui.json"), JSON.stringify({ language: "en-US", theme: "graphite", workingDirectories: projects, currentWorkingDirectory: projects[0], favoriteWorkingDirectories: { [projects[0]!]: true }, favoriteThreads: { "fixture-source": true }, threadNames: Object.fromEntries(threads.map((item) => [item.id, item.title])) }));
    // Allowlist OS/runtime variables, without inheriting credentials or real Codex overrides.
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const runtimePaths = [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")];
    for (const path of runtimePaths) for (const name of ["codex.exe", "codex.cmd", "codex.bat"]) {
      assert.equal(existsSync(join(path, name)), false, "Refuse a runtime PATH containing a real Codex fallback");
    }
    app = await electron.launch({
      executablePath: join(desktop, "node_modules", "electron", "dist", "electron.exe"),
      args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, join(desktop, "out", "main", "index.js")],
      env: { ...env, PATH: runtimePaths.join(delimiter), HOME: userData, USERPROFILE: userData, APPDATA: userData, LOCALAPPDATA: userData, CODEX_HOME: join(userData, "codex"), CODEX_EXECUTABLE: join(desktop, "tests", "e2e", "fake-fork-app-server.cmd"), CODEX_CWD: projects[0]!, GIT_CEILING_DIRECTORIES: scratch, FAKE_FORK_STATE_PATH: statePath, FAKE_FORK_E2E: "1", FAKE_OBSERVATORY: "1", THREADPATH_E2E: "1", THREADPATH_E2E_LANGUAGE: "en-US", ELECTRON_IS_DEV: "0" },
    });
    await app.evaluate(({ BrowserWindow, session }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000);
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 });
    page.setDefaultTimeout(20_000);
    await page.waitForFunction(() => document.querySelector('[aria-label="Connection status"]')?.textContent?.includes("ready"));
    assert.match(await page.locator(".status-meta").innerText(), /fixture-fork-1/);
    await waitForHistorySync(page);
    assert.equal(await page.locator('.workspace-toggle[aria-expanded="true"]').count(), 0, "Beta.4 starts with projects collapsed");
    for (const name of ["Atlas-Desktop", "Orion-API"]) await page.locator(".workspace-toggle").filter({ hasText: name }).click();
    await page.locator(".thread-row").filter({ hasText: topics[0] }).waitFor();
    await page.locator(".turn-composer textarea").fill("Explore a new approach without losing the original conversation.");
    const records: { file: string; width: number; height: number; bytes: number }[] = [];
    const capture = async (name: string): Promise<void> => {
      await settle(page);
      assert.equal(await page.locator(".error-summary").count(), 0);
      assert.doesNotMatch(await page.locator("body").innerText(), /[A-Z]:[\\/]Users[\\/]|Bearer\s|sk-[a-zA-Z0-9]{16,}/i);
      const file = `beta4-${name}.png`;
      const png = await page.screenshot({ path: join(output, file), fullPage: false, scale: "css" });
      assert.equal(png.readUInt32BE(16), 1600);
      assert.equal(png.readUInt32BE(20), 1000);
      records.push({ file, width: 1600, height: 1000, bytes: png.length });
    };
    await capture("workspaces");
    await page.locator(".thread-row").filter({ hasText: topics[0] }).click();
    await page.locator(".conversation-heading h2").waitFor();
    assert.equal(await page.locator('.outline-entry[data-outline-role="user"]').count(), 12);
    assert.equal(await page.locator('.outline-entry[data-outline-role="assistant"]').count(), 12);
    await page.locator('.outline-entry[data-outline-role="assistant"]').filter({ hasText: "Jump to the message that matters" }).click();
    await page.locator('[data-turn-id="demo-turn-4"] .markdown-message table').waitFor({ state: "visible" });
    await capture("navigation");
    await page.locator('.outline-entry[data-outline-role="user"]').filter({ hasText: topics[5] }).click();
    await page.getByRole("button", { name: "Branch from turn 6", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".conversation-heading h2")?.textContent === "Branch 1");
    await page.locator(".branch-history-boundary").waitFor();
    await page.locator('[data-branch-thread-id="fixture-source"]').click();
    await page.locator('.outline-entry[data-outline-role="user"]').filter({ hasText: topics[5] }).click();
    await page.getByRole("button", { name: "Branch from turn 6", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".conversation-heading h2")?.textContent === "Branch 2");
    assert.equal(await page.locator(".branch-node").count(), 3);
    await page.locator(".branch-history-boundary").waitFor();
    await page.locator(".branch-map-scroll").evaluate((element) => { element.scrollTop = 0; element.scrollLeft = 0; });
    await capture("branches");
    await page.locator('[data-branch-thread-id="fixture-source"]').click();
    await page.locator(".turn-composer textarea").fill("Summarize the observed usage for this synthetic discussion.");
    await page.locator(".composer-send").click();
    await page.locator(".usage-observatory summary").filter({ hasText: "70K" }).waitFor();
    await page.locator('.compaction-marker[data-compaction-status="completed"]').waitFor();
    await page.getByRole("button", { name: "Collapse", exact: true }).click();
    await page.locator(".usage-observatory summary").click();
    await page.locator(".usage-details dd").filter({ hasText: /^70,000$/ }).waitFor();
    await page.locator(".usage-details dd").filter({ hasText: /^18,234$/ }).waitFor();
    // These exact counters arrived through the existing fake server's JSONL notifications.
    const observed = await page.evaluate(() => window.threadPath.getThreadObservatory("fixture-source"));
    assert.equal(observed.usage?.total.totalTokens, 70000);
    assert.equal(observed.usage?.last.totalTokens, 18234);
    assert.equal(observed.usage?.source, "live");
    await capture("observatory");
    await writeFile(join(scratchParent, "capture-report.json"), JSON.stringify({ synthetic: true, realModelCalls: false, server: "fake-fork-app-server.cmd", theme: "graphite", images: records, usage: { total: 70000, last: 18234, source: "live" } }, null, 2));
    console.log(JSON.stringify(records, null, 2));
  } finally {
    try { if (app !== undefined) await app.close(); }
    finally {
      // Verify the absolute deletion target is the exclusively created capture directory.
      const target = await realpath(scratch);
      const parent = await realpath(scratchParent);
      const child = relative(parent, target);
      assert.ok(child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && resolve(dirname(target)) === resolve(parent));
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
