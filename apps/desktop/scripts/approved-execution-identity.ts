import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reportPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../artifacts/m6c-readonly-report.json");
const reportSha256 = "D88C3DC1FAFF7B045EAEABEC0A4EE63449C3612B76110C14B3D0F88DEC9D52B1";

/** Production callers use the fixed independent evidence; overrides are for offline tests only. */
export function verifyApprovedExecutionIdentity(options: { path?: string; sha256?: string; username?: () => string } = {}): void {
  try {
    const bytes = readFileSync(options.path ?? reportPath);
    if (createHash("sha256").update(bytes).digest("hex").toUpperCase() !== (options.sha256 ?? reportSha256)) throw new Error();
    const report: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof report !== "object" || report === null || Array.isArray(report) || !("environment" in report)) throw new Error();
    const environment: unknown = report.environment;
    if (typeof environment !== "object" || environment === null || Array.isArray(environment) || !("executionIdentity" in environment)) throw new Error();
    const identity: unknown = environment.executionIdentity;
    if (typeof identity !== "string" || !identity.trim() || identity !== (options.username ?? (() => userInfo().username))()) throw new Error();
  } catch {
    // Never expose either identity, the report path, or parsing/system errors.
    throw new Error("approved execution identity verification failed");
  }
}
