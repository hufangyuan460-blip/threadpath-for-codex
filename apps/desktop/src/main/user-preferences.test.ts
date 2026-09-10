import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automaticThreadDisplayName, sanitizeThreadDisplayName, threadDisplayName, UserPreferencesService } from "./user-preferences.ts";

async function main(): Promise<void> {
  assert.equal(sanitizeThreadDisplayName("  <b>Hello</b>\nworld\u0000  "), "Hello world");
  assert.equal(sanitizeThreadDisplayName("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij");
  assert.equal(threadDisplayName({ customName: " Local ", firstUserText: "User", serverTitle: "Server", language: "en-US" }), "Local");
  assert.equal(automaticThreadDisplayName({ firstUserText: "<tool>\nAsk this", serverTitle: "Server", language: "zh-CN" }), "Ask this");
  assert.equal(automaticThreadDisplayName({ language: "zh-CN" }), "未命名会话");
  assert.equal(automaticThreadDisplayName({ language: "en-US" }), "Untitled conversation");

  const directory = await mkdtemp(join(tmpdir(), "threadpath-preferences-"));
  const path = join(directory, "preferences.json");
  const preferences = new UserPreferencesService(path, "en-US");
  await preferences.load();
  assert.equal(preferences.getLanguage(), "en-US");
  await preferences.setLanguage("zh-CN");
  await preferences.setThreadDisplayName("thread-1", "My local name");
  assert.equal(preferences.getThreadDisplayName("thread-1", "Server"), "My local name");
  const reloaded = new UserPreferencesService(path, "en-US");
  await reloaded.load();
  assert.equal(reloaded.getLanguage(), "zh-CN");
  assert.equal(reloaded.getThreadDisplayName("thread-1", "Server"), "My local name");
  await reloaded.setThreadDisplayName("thread-1", null);
  assert.equal(reloaded.getThreadDisplayName("thread-1", "Server"), "Server");
  await reloaded.setThreadDisplayName("thread-2", "stale");
  await reloaded.pruneThreadNames(["thread-1"]);
  assert.equal(reloaded.getThreadDisplayName("thread-2", "Server"), "Server");
  const saved = await readFile(path, "utf8");
  assert.ok(!saved.includes("token"));
  console.log("[desktop-test] user preference checks passed");
}

main().catch((error: unknown) => { console.error(`[desktop-test] FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
