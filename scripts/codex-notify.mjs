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

const eventType = String(payload.type || payload.event || "").toLowerCase();
const state = eventType.includes("fail") || eventType.includes("error") ? "failed" : "jumping";
spawnSync(process.execPath, [path.join(scriptDir, "set-state.mjs"), state], {
  env: { ...process.env, CODEX_PET_SOURCE: "codex-notify" },
  windowsHide: true,
  stdio: "ignore",
});
