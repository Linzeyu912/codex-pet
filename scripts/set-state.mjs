import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const aliases = {
  ready: "review",
  complete: "jumping",
  blocked: "failed",
  "needs-input": "waiting",
  working: "running",
  thinking: "running",
};
const validStates = new Set([
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
  "looking",
  "rolling",
  "lying",
  "mischief",
]);

const defaultTtlByState = {
  "running-right": 20_000,
  "running-left": 20_000,
  waving: 12_000,
  jumping: 12_000,
  failed: 5 * 60_000,
  waiting: 15 * 60_000,
  running: 15 * 60_000,
  review: 30_000,
  looking: 15_000,
  rolling: 15_000,
  lying: 20_000,
  mischief: 15_000,
};

function readOption(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizeNonEmpty(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function resolveExpiry(state, now) {
  if (state === "idle") return undefined;
  const requested = readOption("--ttl-ms") ?? process.env.CODEX_PET_TTL_MS;
  const parsed = requested === undefined ? defaultTtlByState[state] : Number(requested);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--ttl-ms must be a positive number, got: ${requested}`);
  }
  return now + Math.round(parsed);
}

const requested = (process.argv[2] || "idle").trim().toLowerCase();
const state = aliases[requested] || requested;
if (!validStates.has(state)) {
  console.error(`Unknown state: ${requested}`);
  console.error(`Available states: ${[...validStates].join(", ")}`);
  process.exitCode = 1;
} else {
  const directory = path.join(os.homedir(), ".codex-pet");
  const destination = path.join(directory, "state.json");
  const temporary = path.join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
  const updatedAt = Date.now();
  const source = normalizeNonEmpty(process.env.CODEX_PET_SOURCE) || "cli";
  const requestedSession = normalizeNonEmpty(readOption("--session") ?? process.env.CODEX_PET_SESSION_ID);
  const payload = {
    state,
    updatedAt,
    source,
    sessionId: requestedSession || `${source}:${process.pid}`,
  };
  const expiresAt = resolveExpiry(state, updatedAt);
  if (expiresAt !== undefined) payload.expiresAt = expiresAt;
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  console.log(`Codex Pet state: ${state}`);
}
