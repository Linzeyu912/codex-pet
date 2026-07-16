import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const notifyScript = path.join(scriptDir, "codex-notify.mjs");
const setStateScript = path.join(scriptDir, "set-state.mjs");
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pet-state-bridge-"));
const statePath = path.join(temporaryHome, ".codex-pet", "state.json");
const legacyTtlMs = 15 * 60 * 1000;

function extractFunction(sourceText, functionName) {
  const marker = `function ${functionName}(`;
  const start = sourceText.indexOf(marker);
  const bodyStart = sourceText.indexOf("{", start);
  if (start < 0 || bodyStart < 0) throw new Error(`src/main.ts no longer defines ${functionName}.`);
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    if (sourceText[index] === "{") depth += 1;
    else if (sourceText[index] === "}" && --depth === 0) return sourceText.slice(start, index + 1);
  }
  throw new Error(`${functionName} has an unterminated function body.`);
}

async function loadMainStateHelpers() {
  const mainPath = path.join(scriptDir, "..", "src", "main.ts");
  const sourceText = await fs.readFile(mainPath, "utf8");
  const fixturePath = path.join(temporaryHome, "payload-expiry-fixture.mts");
  const outputPath = path.join(temporaryHome, "payload-expiry-fixture.mjs");
  const declarations = ["payloadExpiry", "normalizeSessionId", "isValidExternalUpdatedAt"]
    .map((functionName) => `export ${extractFunction(sourceText, functionName)}`)
    .join("\n");
  await fs.writeFile(
    fixturePath,
    `interface PetStatePayload { state: string; updatedAt: unknown; expiresAt?: unknown; sessionId?: unknown }\n` +
      `const LEGACY_STATE_TTL_MS = ${legacyTtlMs};\n${declarations}\n`,
    "utf8",
  );
  const tscScript = path.join(scriptDir, "..", "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(
    process.execPath,
    [
      tscScript,
      fixturePath,
      "--ignoreConfig",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--skipLibCheck",
      "--outDir",
      temporaryHome,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
    throw new Error(`Main state-helper fixture compilation failed: ${detail}`);
  }
  return import(pathToFileURL(outputPath).href);
}

function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) throw new Error(`${message} Expected ${expected}, got ${actual}.`);
}

async function testPayloadExpiry() {
  const { payloadExpiry, normalizeSessionId, isValidExternalUpdatedAt } = await loadMainStateHelpers();
  const updatedAt = 1_800_000_000_000;
  const fallback = updatedAt + legacyTtlMs;
  for (const invalid of [
    0,
    -1,
    -0.5,
    "0",
    "-1",
    "not-a-date",
    "",
    null,
    undefined,
    true,
    { unexpected: true },
    [1, 2],
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assertEqual(
      payloadExpiry({ state: "running", updatedAt, expiresAt: invalid }),
      fallback,
      `Invalid expiresAt ${String(invalid)} must use the compatibility TTL.`,
    );
  }
  assertEqual(
    payloadExpiry({ state: "running", updatedAt, expiresAt: "1e12" }),
    1_000_000_000_000,
    "A positive numeric string must be parsed as Unix milliseconds before date parsing.",
  );
  assertEqual(
    payloadExpiry({ state: "running", updatedAt, expiresAt: 0.5 }),
    0.5,
    "A positive fractional expiration must remain finite and expire immediately rather than pinning state.",
  );
  const isoExpiry = 1_900_000_000_000;
  assertEqual(
    payloadExpiry({ state: "running", updatedAt, expiresAt: new Date(isoExpiry).toISOString() }),
    isoExpiry,
    "A valid ISO expiration must be preserved.",
  );
  assertEqual(
    payloadExpiry({ state: "idle", updatedAt, expiresAt: "0" }),
    0,
    "An idle payload with an invalid expiration must remain non-expiring.",
  );
  assertEqual(normalizeSessionId(undefined), "legacy", "A missing sessionId must use the legacy read identity.");
  assertEqual(normalizeSessionId(""), "legacy", "An empty sessionId must use the legacy read identity.");
  assertEqual(normalizeSessionId("   "), "legacy", "A blank sessionId must use the legacy read identity.");
  assertEqual(normalizeSessionId(123), "legacy", "A non-string sessionId must use the legacy read identity.");
  assertEqual(normalizeSessionId(["task-1"]), "legacy", "An array sessionId must use the legacy read identity.");
  assertEqual(normalizeSessionId({ id: "task-1" }), "legacy", "An object sessionId must use the legacy read identity.");
  assertEqual(normalizeSessionId("  task-1  "), "task-1", "A sessionId must be trimmed before comparison.");
  assertEqual(isValidExternalUpdatedAt(1), true, "A positive safe-integer updatedAt must be accepted.");
  assertEqual(
    isValidExternalUpdatedAt(Number.MAX_SAFE_INTEGER),
    true,
    "The largest safe-integer updatedAt must be accepted.",
  );
  for (const invalidUpdatedAt of [
    0,
    -1,
    1.5,
    "1",
    true,
    null,
    undefined,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assertEqual(
      isValidExternalUpdatedAt(invalidUpdatedAt),
      false,
      `Invalid updatedAt ${String(invalidUpdatedAt)} must not take over state.`,
    );
  }
  assertEqual(
    payloadExpiry({ state: "running", updatedAt: 0, expiresAt: "0" }),
    legacyTtlMs,
    "The expiry helper must retain a finite fallback even though applyRemoteState rejects updatedAt zero.",
  );
}

function runStateWriter(scriptPath, argumentsList, environment = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...argumentsList], {
    env: {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      ...environment,
    },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
    throw new Error(`State-writer fixture failed for ${path.basename(scriptPath)}: ${detail}`);
  }
}

function runNotification(payload) {
  runStateWriter(notifyScript, [JSON.stringify(payload)]);
}

function runSetState(...argumentsList) {
  runStateWriter(setStateScript, argumentsList, {
    CODEX_PET_SOURCE: "cli",
    CODEX_PET_SESSION_ID: "",
  });
}

async function readState() {
  return JSON.parse(await fs.readFile(statePath, "utf8"));
}

try {
  await testPayloadExpiry();
  runNotification({
    type: "agent-turn-complete",
    "thread-id": "  official-thread-id  ",
    "turn-id": "turn-1",
  });
  const officialState = await readState();
  if (officialState.state !== "jumping") {
    throw new Error(`Official agent-turn-complete mapped to ${officialState.state}, expected jumping.`);
  }
  if (officialState.sessionId !== "official-thread-id") {
    throw new Error(
      `Official thread-id was written as ${officialState.sessionId}, expected official-thread-id.`,
    );
  }
  if (officialState.source !== "codex-notify") {
    throw new Error(`Notification source was ${officialState.source}, expected codex-notify.`);
  }

  runNotification({ type: "custom-error", threadId: "legacy-alias" });
  const customState = await readState();
  if (customState.state !== "failed" || customState.sessionId !== "legacy-alias") {
    throw new Error("Custom fail/error compatibility or an existing thread-id alias regressed.");
  }

  runNotification({ type: "agent-turn-complete", "thread-id": "   ", threadId: "  alias-after-blank  " });
  const aliasAfterBlank = await readState();
  assertEqual(
    aliasAfterBlank.sessionId,
    "alias-after-blank",
    "A blank official thread-id must not mask a later non-empty compatibility alias.",
  );

  runNotification({ type: "agent-turn-complete", "thread-id": "   " });
  const defaultNotifySession = await readState();
  assertEqual(
    defaultNotifySession.sessionId,
    "codex-notify",
    "A notification without a usable thread ID must use its safe writer default.",
  );

  runSetState("running", "--session", "   ");
  const defaultSession = await readState();
  if (!/^cli:\d+$/.test(defaultSession.sessionId)) {
    throw new Error(`A blank CLI session must use a safe default ID, got ${defaultSession.sessionId}.`);
  }
  if (!(defaultSession.updatedAt > 0)) throw new Error("set-state must always write a positive updatedAt.");

  runSetState("running", "--session", "  named-session  ");
  const namedSession = await readState();
  assertEqual(namedSession.sessionId, "named-session", "A CLI session ID must be trimmed before writing.");

  console.log("State bridge self-tests passed.");
} finally {
  await fs.rm(temporaryHome, { recursive: true, force: true });
}
