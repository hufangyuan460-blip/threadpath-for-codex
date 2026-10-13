import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestName, sumsName, verifyReleaseArtifacts } from "./release-artifacts.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = await verifyReleaseArtifacts(repo);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error("GitHub repository/token must be supplied by the release workflow");
if (process.env.GITHUB_REF_NAME !== manifest.tag) throw new Error("Workflow ref differs from the verified release tag");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ThreadPath-release" };
const base = `https://api.github.com/repos/${repository}`;
// GitHub's JSON responses are typed only at this API boundary. Never log headers/tokens.
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
  return await response.json() as T;
}

let target = (await api<{ object: { type: string; sha: string } }>(`/git/ref/tags/${manifest.tag}`)).object;
for (let depth = 0; target.type === "tag" && depth < 5; depth++) {
  target = (await api<{ object: { type: string; sha: string } }>(`/git/tags/${target.sha}`)).object;
}
assert.equal(target.type, "commit", "Remote release tag does not resolve to a commit");
assert.equal(target.sha, manifest.commit, "Remote tag differs from packaged source");
const existing = await fetch(`${base}/releases/tags/${manifest.tag}`, { headers, signal: AbortSignal.timeout(120000) });
if (existing.status !== 404) throw new Error(existing.ok ? "Release already exists; published versions must never be replaced" : `Release lookup failed: ${existing.status}`);
const notes = await readFile(join(repo, "docs", "releases", `${manifest.tag}.md`), "utf8");
const body = `${notes}\n\nSource / 源码: [${manifest.commit}](https://github.com/${repository}/commit/${manifest.commit})\n\nSHA-256: \`${manifest.installer.sha256}\`\n`;
const release = await api<{ id: number; html_url: string }>("/releases", "POST", {
  tag_name: manifest.tag, target_commitish: manifest.commit, name: `ThreadPath for Codex ${manifest.tag}`,
  body, draft: true, prerelease: manifest.version.includes("-"),
});
for (const name of [manifest.installer.name, manifestName(manifest.version), sumsName(manifest.version)]) {
  const bytes = await readFile(join(repo, "release", name));
  const assetName = name.replaceAll(" ", ".");
  const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`Asset upload failed: ${response.status}; release remains a draft`);
  const asset = await response.json() as { size: number; state: string; digest: string; name: string };
  assert.equal(asset.name, assetName);
  assert.equal(asset.size, bytes.length);
  assert.equal(asset.state, "uploaded");
  assert.equal(asset.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`, "Uploaded asset checksum differs");
}
await api(`/releases/${release.id}`, "PATCH", { draft: false });
console.log(`[release] published ${release.html_url} from ${manifest.commit}`);
