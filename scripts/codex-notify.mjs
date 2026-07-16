import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let payload = {};
try {
  payload = JSON.parse(process.argv.at(-1) || "{}");
} catch {
  // Unknown payloads still map to a gentle ready animation.
}
if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

function firstNonEmptyId(...values) {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "codex-notify";
}

const eventType = String(payload.type || payload.event || "").toLowerCase();
const state = eventType.includes("fail") || eventType.includes("error") ? "failed" : "jumping";
const sessionId = firstNonEmptyId(
  payload["thread-id"],
  payload.thread_id,
  payload.threadId,
  payload.session_id,
  payload.sessionId,
);
const ttlMs = state === "failed" ? 45_000 : 12_000;
const result = spawnSync(
  process.execPath,
  [path.join(scriptDir, "set-state.mjs"), state, "--ttl-ms", String(ttlMs), "--session", sessionId],
  {
    env: { ...process.env, CODEX_PET_SOURCE: "codex-notify" },
    windowsHide: true,
    encoding: "utf8",
  },
);

if (result.error || result.status !== 0) {
  const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
  console.error(`Codex Pet notification bridge failed: ${detail}`);
  process.exitCode = result.status || 1;
}
